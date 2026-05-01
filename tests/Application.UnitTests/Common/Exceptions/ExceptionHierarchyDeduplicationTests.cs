using System.Linq;
using System.Reflection;
using CleanArchitecture.Application.Common.Exceptions;
using CleanArchitecture.Domain.Exceptions;
using FluentAssertions;
using NUnit.Framework;

namespace CleanArchitecture.Application.UnitTests.Common.Exceptions
{
    // Regression tests for TICKET-005.
    //
    // The CRUD-style exceptions (NotFoundException, ValidationException,
    // ForbiddenAccessException) are owned by the Application layer. Reintroducing
    // a twin in the Domain layer recreates the catch/throw ambiguity this ticket
    // resolved, so these tests fail loudly if anyone restores a duplicate.
    public class ExceptionHierarchyDeduplicationTests
    {
        private static readonly string[] DeduplicatedExceptionNames =
        {
            "NotFoundException",
            "ValidationException",
            "ForbiddenAccessException",
        };

        private static Assembly DomainAssembly => typeof(UnsupportedColourException).Assembly;
        private static Assembly ApplicationAssembly => typeof(NotFoundException).Assembly;

        [TestCaseSource(nameof(DeduplicatedExceptionNames))]
        public void Domain_assembly_must_not_define_the_deduplicated_exception(string typeName)
        {
            var matches = DomainAssembly
                .GetTypes()
                .Where(t => t.Name == typeName)
                .ToArray();

            matches.Should().BeEmpty(
                $"'{typeName}' was deduplicated to the Application layer; restoring a Domain copy " +
                "reintroduces the catch/throw ambiguity that TICKET-005 removed.");
        }

        [TestCaseSource(nameof(DeduplicatedExceptionNames))]
        public void Application_assembly_must_define_the_canonical_exception(string typeName)
        {
            var matches = ApplicationAssembly
                .GetTypes()
                .Where(t => t.Namespace == "CleanArchitecture.Application.Common.Exceptions"
                            && t.Name == typeName)
                .ToArray();

            matches.Should().HaveCount(1,
                $"'{typeName}' is the canonical Application exception and every consumer imports it from there.");
        }

        [Test]
        public void Domain_exceptions_namespace_only_contains_invariant_violations()
        {
            var domainExceptionTypeNames = DomainAssembly
                .GetTypes()
                .Where(t => t.Namespace == "CleanArchitecture.Domain.Exceptions")
                .Select(t => t.Name)
                .ToArray();

            // Domain exceptions exist to express domain-invariant violations
            // (e.g. UnsupportedColourException). Generic CRUD exceptions belong
            // in Application.Common.Exceptions. Update this list only when a new
            // *invariant* exception is intentionally added.
            domainExceptionTypeNames.Should().BeEquivalentTo(new[] { "UnsupportedColourException" });
        }
    }
}
