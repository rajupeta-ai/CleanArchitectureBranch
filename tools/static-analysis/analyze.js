#!/usr/bin/env node
// Static analysis health-score baseline analyzer.
//
// Pure-Node, zero-dependency Roslyn-equivalent pattern scanner. Produces a
// generic JSON report (rule id + file path + severity) so the underlying tool
// can be swapped to NDepend, SonarScanner, or `dotnet build /warnaserror`
// later without changing downstream consumers (CI dashboards, milestone
// comparison scripts).
//
// Determinism guarantees:
//   * Files are walked in lexicographic order.
//   * Violations within a file are emitted in (line, column, ruleId) order.
//   * No timestamps, machine paths, or environment data appear in output.
//   * Rule weights and the score formula are constants in this file.

'use strict';

const fs = require('fs');
const path = require('path');

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

const SEVERITY_WEIGHTS = {
  critical: 3.0,
  major: 1.0,
  minor: 0.2,
  info: 0.0,
};

const DEFAULT_SCAN_ROOTS = ['src', 'tests'];

const EXCLUDED_PATH_FRAGMENTS = [
  '/bin/',
  '/obj/',
  '/Migrations/', // EF Core generated migrations are out of scope
  '/.git/',
  '/node_modules/',
];

// --------------------------------------------------------------------------
// Rule definitions. Each rule is a pure function: (file, lines) -> Violation[]
// Rule IDs follow Roslyn/Sonar conventions where possible so a future swap to
// the real tools yields recognizable IDs.
// --------------------------------------------------------------------------

/** @typedef {{ ruleId: string, severity: string, file: string, line: number, column: number, message: string }} Violation */

const RULES = [
  {
    id: 'CA1031',
    severity: 'major',
    title: 'Do not catch general exception types',
    detect(file, lines) {
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const m = /^\s*catch\s*\(\s*Exception(\s+\w+)?\s*\)/.exec(lines[i]);
        if (m) {
          out.push(mkViolation('CA1031', 'major', file, i + 1, m.index + 1,
            'catch (Exception) is too broad — catch a specific exception type'));
        }
      }
      return out;
    },
  },
  {
    id: 'CA1051',
    severity: 'major',
    title: 'Do not declare visible instance fields',
    detect(file, lines) {
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // public non-readonly, non-const, non-static field with no { get; }
        const m = /^\s*public\s+(?!(class|interface|struct|enum|record|const|static\s+readonly|readonly)\b)([A-Za-z_][\w<>?\[\],\s.]*?)\s+([A-Za-z_]\w*)\s*[=;]/.exec(line);
        if (m && !line.includes('{') && !line.includes('(')) {
          out.push(mkViolation('CA1051', 'major', file, i + 1, 1,
            `Public field '${m[3]}' should be a property`));
        }
      }
      return out;
    },
  },
  {
    id: 'CA1707',
    severity: 'minor',
    title: 'Identifiers should not contain underscores',
    detect(file, lines) {
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // public methods or types with underscore in name (excluding test files)
        if (/Tests?\.cs$/.test(file)) continue; // test method names commonly use underscores
        const m = /\b(public|internal)\s+(?:static\s+)?(?:async\s+)?(?:[A-Za-z_][\w<>?\[\],.\s]*?\s+)?([A-Za-z]\w*_\w+)\s*\(/.exec(line);
        if (m) {
          out.push(mkViolation('CA1707', 'minor', file, i + 1, 1,
            `Identifier '${m[2]}' contains underscore`));
        }
      }
      return out;
    },
  },
  {
    id: 'CA1822',
    severity: 'minor',
    title: 'Mark members as static when they do not access instance state',
    detect(_file, _lines) {
      // Conservative: skipped because reliable detection requires symbol resolution.
      // Kept as a documented placeholder in the ruleset.
      return [];
    },
  },
  {
    id: 'CA2007',
    severity: 'minor',
    title: 'Consider calling ConfigureAwait on the awaited task',
    detect(file, lines) {
      const out = [];
      // Library code only — WebUI/API entrypoints can omit ConfigureAwait
      if (/[\\/]WebUI[\\/]/.test(file)) return out;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/\bawait\s+/.test(line) && !/ConfigureAwait\s*\(/.test(line)) {
          // Skip awaits that span multiple lines — best effort
          if (/;\s*$/.test(line)) {
            out.push(mkViolation('CA2007', 'minor', file, i + 1, 1,
              'await without ConfigureAwait(false) in library code'));
          }
        }
      }
      return out;
    },
  },
  {
    id: 'S1135',
    severity: 'info',
    title: 'Track uses of TODO/FIXME/HACK tags',
    detect(file, lines) {
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const m = /\/\/.*\b(TODO|FIXME|HACK|XXX)\b/.exec(lines[i]);
        if (m) {
          out.push(mkViolation('S1135', 'info', file, i + 1, m.index + 1,
            `${m[1]} comment found — track and resolve`));
        }
      }
      return out;
    },
  },
  {
    id: 'S125',
    severity: 'minor',
    title: 'Sections of code should not be commented out',
    detect(file, lines) {
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Heuristic: //-comment that ends with ; or { or }
        if (/^\s*\/\/\s*[^\/\s].*[;{}]\s*$/.test(line) && !/TODO|FIXME|HACK|XXX|note:|see /i.test(line)) {
          out.push(mkViolation('S125', 'minor', file, i + 1, 1,
            'Possible commented-out code'));
        }
      }
      return out;
    },
  },
  {
    id: 'S1481',
    severity: 'minor',
    title: 'Unused local variables should be removed',
    detect(_file, _lines) {
      // Requires data-flow analysis — out of scope for the pattern scanner.
      // Documented as known-not-implemented in health-metrics.md.
      return [];
    },
  },
  {
    id: 'S2486',
    severity: 'major',
    title: 'Generic exceptions should not be ignored',
    detect(file, lines) {
      const out = [];
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\s*catch\s*\(/.test(lines[i])) {
          // Look for empty body within next 3 lines
          const next1 = (lines[i + 1] || '').trim();
          const next2 = (lines[i + 2] || '').trim();
          if ((next1 === '{' && next2 === '}') || next1 === '{}') {
            out.push(mkViolation('S2486', 'major', file, i + 1, 1,
              'Empty catch block silently swallows the exception'));
          }
        }
      }
      return out;
    },
  },
  {
    id: 'S3776',
    severity: 'major',
    title: 'Cognitive Complexity of methods should not be too high',
    detect(file, lines) {
      const out = [];
      let braceDepth = 0;
      let methodStart = -1;
      let methodComplexity = 0;
      let methodName = '';
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const sigMatch = /^\s*(?:public|private|protected|internal)[^=;]*\b([A-Z]\w*)\s*\([^)]*\)\s*(\{?)\s*$/.exec(line);
        if (sigMatch && braceDepth === 0 && !line.includes('=>')) {
          methodStart = i;
          methodComplexity = 0;
          methodName = sigMatch[1];
        }
        if (methodStart >= 0) {
          if (/\bif\b|\belse\b|\bfor\b|\bforeach\b|\bwhile\b|\bcase\b|\bcatch\b|&&|\|\|/.test(line)) {
            methodComplexity++;
          }
        }
        const opens = (line.match(/\{/g) || []).length;
        const closes = (line.match(/\}/g) || []).length;
        braceDepth += opens - closes;
        if (methodStart >= 0 && braceDepth === 0 && (opens || closes)) {
          if (methodComplexity > 15) {
            out.push(mkViolation('S3776', 'major', file, methodStart + 1, 1,
              `Method '${methodName}' has cognitive complexity ${methodComplexity} (threshold 15)`));
          }
          methodStart = -1;
        }
      }
      return out;
    },
  },
  {
    id: 'S138',
    severity: 'major',
    title: 'Methods should not have too many lines',
    detect(file, lines) {
      const out = [];
      let braceDepth = 0;
      let methodStart = -1;
      let methodName = '';
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const sigMatch = /^\s*(?:public|private|protected|internal)[^=;]*\b([A-Z]\w*)\s*\([^)]*\)\s*(\{?)\s*$/.exec(line);
        if (sigMatch && braceDepth === 0 && !line.includes('=>')) {
          methodStart = i;
          methodName = sigMatch[1];
        }
        const opens = (line.match(/\{/g) || []).length;
        const closes = (line.match(/\}/g) || []).length;
        braceDepth += opens - closes;
        if (methodStart >= 0 && braceDepth === 0 && (opens || closes)) {
          const lineCount = i - methodStart + 1;
          if (lineCount > 80) {
            out.push(mkViolation('S138', 'major', file, methodStart + 1, 1,
              `Method '${methodName}' is ${lineCount} lines long (threshold 80)`));
          }
          methodStart = -1;
        }
      }
      return out;
    },
  },
  {
    id: 'CA1812',
    severity: 'minor',
    title: 'Avoid uninstantiated internal classes (dead code)',
    detect(file, lines) {
      // Heuristic: flag classes whose name appears only at the declaration site
      // across the entire scanned tree. Implemented at corpus level below.
      return [];
    },
  },
  {
    id: 'IDE0044',
    severity: 'minor',
    title: 'Add readonly modifier to fields assigned only in ctor',
    detect(file, lines) {
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // private non-readonly field (heuristic; some may legitimately be reassigned)
        const m = /^\s*private\s+(?!readonly|static|const)([A-Za-z_][\w<>?\[\],.\s]*?)\s+_([A-Za-z]\w*)\s*[=;]/.exec(line);
        if (m && !line.includes('(')) {
          out.push(mkViolation('IDE0044', 'minor', file, i + 1, 1,
            `Field '_${m[2]}' could be readonly`));
        }
      }
      return out;
    },
  },
  {
    id: 'CA1054',
    severity: 'minor',
    title: 'URI parameters should not be strings',
    detect(file, lines) {
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/\b(Uri|Url|Endpoint)\s*[:,)]/i.test(line) && /string\s+(uri|url|endpoint)\b/i.test(line)) {
          out.push(mkViolation('CA1054', 'minor', file, i + 1, 1,
            'URI-named parameter typed as string instead of System.Uri'));
        }
      }
      return out;
    },
  },
  {
    id: 'S1075',
    severity: 'major',
    title: 'URIs should not be hardcoded',
    detect(file, lines) {
      const out = [];
      // Skip Migrations/launchSettings — those are config artifacts
      if (/launchSettings|appsettings|\.json$/.test(file)) return out;
      for (let i = 0; i < lines.length; i++) {
        const m = /"https?:\/\/[^"\s]+"/.exec(lines[i]);
        if (m && !/example\.com|localhost/.test(m[0])) {
          out.push(mkViolation('S1075', 'major', file, i + 1, m.index + 1,
            'Hardcoded absolute URI'));
        }
      }
      return out;
    },
  },
  {
    id: 'CA1303',
    severity: 'minor',
    title: 'Do not pass literals as localized parameters',
    detect(file, lines) {
      const out = [];
      // Flag string literals passed to throw new Exception("...") / ArgumentException
      for (let i = 0; i < lines.length; i++) {
        if (/throw\s+new\s+\w*Exception\s*\(\s*"[^"]+"/.test(lines[i])) {
          out.push(mkViolation('CA1303', 'minor', file, i + 1, 1,
            'Hardcoded exception message literal'));
        }
      }
      return out;
    },
  },
];

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function mkViolation(ruleId, severity, file, line, column, message) {
  return { ruleId, severity, file, line, column, message };
}

function walkCsFiles(roots, repoRoot) {
  /** @type {string[]} */
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(repoRoot, full).replace(/\\/g, '/');
      if (EXCLUDED_PATH_FRAGMENTS.some((f) => ('/' + rel + '/').includes(f))) continue;
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.cs')) {
        out.push(rel);
      }
    }
  }
  for (const root of roots) {
    const abs = path.join(repoRoot, root);
    if (fs.existsSync(abs)) walk(abs);
  }
  return out;
}

// Suffixes that mark a class as resolved by a framework via reflection
// (DI, MediatR, FluentValidation, EF Core, AutoMapper, ASP.NET, etc.). These
// are intentionally NOT flagged as dead code, even when the source-text scan
// finds no references — the references happen at runtime via reflection.
const REFLECTION_RESOLVED_SUFFIXES = [
  'Handler', 'Validator', 'Behaviour', 'Behavior', 'Configuration',
  'Profile', 'Service', 'Map', 'Filter', 'Attribute', 'Module',
  'Hub', 'Controller', 'Page', 'Component', 'Middleware',
  'Migration', 'ContextSeed', 'Extensions', 'Builder',
  'Factory', 'Repository', 'Provider', 'Options',
];

// Interface/base-class fragments that mark a class as framework-resolved.
const REFLECTION_RESOLVED_BASES = [
  'IRequestHandler', 'IRequest', 'INotificationHandler',
  'IPipelineBehavior', 'IPipelineBehaviour',
  'AbstractValidator', 'IValidator',
  'IEntityTypeConfiguration', 'DbContext',
  'Profile', 'ControllerBase', 'PageModel',
  'BackgroundService', 'IHostedService',
  'Migration', 'IdentityUser', 'IDesignTimeDbContextFactory',
];

function detectDeadInternalClasses(repoRoot, files) {
  // Find `internal class X` / `public class X` declarations and check whether
  // the symbol X is referenced anywhere outside its own declaration file. This
  // is an intentionally conservative pass — false negatives are fine; false
  // positives must be near-zero so the baseline is honest.
  const declarations = []; // { file, line, name, baseDecl }
  const fileContents = new Map();
  for (const f of files) {
    const abs = path.join(repoRoot, f);
    const text = fs.readFileSync(abs, 'utf8');
    fileContents.set(f, text);
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      // Match the class signature, optionally with a base list spanning the same line
      const m = /^\s*(?:public|internal)\s+(?:sealed\s+|abstract\s+|static\s+|partial\s+)*class\s+([A-Z]\w*)\b([^{]*)/.exec(lines[i]);
      if (m) declarations.push({ file: f, line: i + 1, name: m[1], baseDecl: m[2] || '' });
    }
  }
  const violations = [];
  for (const d of declarations) {
    // Skip framework-resolved suffixes
    if (REFLECTION_RESOLVED_SUFFIXES.some((s) => d.name.endsWith(s))) continue;
    // Skip if base/interface list mentions a framework type
    if (REFLECTION_RESOLVED_BASES.some((b) => d.baseDecl.includes(b))) continue;

    let referenced = false;
    for (const [otherFile, text] of fileContents) {
      if (otherFile === d.file) continue;
      if (new RegExp(`\\b${d.name}\\b`).test(text)) {
        referenced = true;
        break;
      }
    }
    if (!referenced) {
      violations.push(mkViolation('CA1812', 'minor', d.file, d.line, 1,
        `Class '${d.name}' appears unreferenced outside its declaration file (possible dead code)`));
    }
  }
  return violations;
}

function computeHealthScore(violations) {
  let penalty = 0;
  for (const v of violations) {
    penalty += SEVERITY_WEIGHTS[v.severity] || 0;
  }
  const score = Math.max(0, Math.round((100 - penalty) * 10) / 10);
  return score;
}

function summarize(violations) {
  const byRule = {};
  const bySeverity = { critical: 0, major: 0, minor: 0, info: 0 };
  for (const v of violations) {
    byRule[v.ruleId] = (byRule[v.ruleId] || 0) + 1;
    if (bySeverity[v.severity] !== undefined) bySeverity[v.severity]++;
  }
  // Stable rule ordering
  const orderedByRule = {};
  Object.keys(byRule).sort().forEach((k) => { orderedByRule[k] = byRule[k]; });
  return { byRule: orderedByRule, bySeverity };
}

// --------------------------------------------------------------------------
// Public API (also exported for tests)
// --------------------------------------------------------------------------

function analyze(repoRoot, scanRoots) {
  const files = walkCsFiles(scanRoots || DEFAULT_SCAN_ROOTS, repoRoot);
  /** @type {Violation[]} */
  let violations = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    const lines = text.split(/\r?\n/);
    for (const rule of RULES) {
      try {
        const found = rule.detect(file, lines);
        if (found && found.length) violations.push(...found);
      } catch (err) {
        // Rule failures are themselves a violation of the contract — surface
        // them rather than silently swallowing.
        violations.push(mkViolation('SCANNER_ERROR', 'critical', file, 0, 0,
          `Rule ${rule.id} threw: ${err.message}`));
      }
    }
  }
  violations = violations.concat(detectDeadInternalClasses(repoRoot, files));

  // Deterministic ordering: file, line, column, ruleId
  violations.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.line !== b.line) return a.line - b.line;
    if (a.column !== b.column) return a.column - b.column;
    return a.ruleId.localeCompare(b.ruleId);
  });

  const summary = summarize(violations);
  const score = computeHealthScore(violations);

  return {
    schemaVersion: 1,
    tool: 'roslyn-equivalent-pattern-scanner',
    toolVersion: '1.0.0',
    rulesetId: 'clean-architecture-baseline-v1',
    scanRoots: scanRoots || DEFAULT_SCAN_ROOTS,
    filesAnalyzed: files.length,
    overallScore: score,
    targetScore: 80,
    severityWeights: SEVERITY_WEIGHTS,
    summary,
    violations,
  };
}

module.exports = {
  analyze,
  computeHealthScore,
  RULES,
  SEVERITY_WEIGHTS,
};

// --------------------------------------------------------------------------
// CLI entrypoint
// --------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  let repoRoot = process.cwd();
  let outFile = path.join('artifacts', 'health-score-baseline.json');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' && args[i + 1]) { repoRoot = path.resolve(args[++i]); }
    else if (args[i] === '--out' && args[i + 1]) { outFile = args[++i]; }
  }
  const report = analyze(repoRoot);
  const outAbs = path.isAbsolute(outFile) ? outFile : path.join(repoRoot, outFile);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, JSON.stringify(report, null, 2) + '\n');
  // eslint-disable-next-line no-console
  console.log(`Analyzed ${report.filesAnalyzed} files. Found ${report.violations.length} violations. Overall score: ${report.overallScore}. Wrote ${outFile}.`);
}
