using CleanArchitecture.Application.Common.Exceptions;
using CleanArchitecture.Application.TodoLists.Commands.CreateTodoList;
using CleanArchitecture.Application.TodoLists.Commands.DeleteTodoList;
using CleanArchitecture.Application.TodoLists.Commands.UpdateTodoList;
using CleanArchitecture.Application.TodoLists.Queries.GetTodos;
using CleanArchitecture.Domain.Entities;
using FluentAssertions;
using NUnit.Framework;
using System.Linq;
using System.Threading.Tasks;

namespace CleanArchitecture.Application.IntegrationTests.CharacterizationTests
{
    using static Testing;

    // Characterization tests that lock in the current behavior of the TodoLists API surface.
    //
    // NOTE on infrastructure: the ticket prescribes HttpClient + CustomWebApplicationFactory,
    // but no CustomWebApplicationFactory exists in this repo and there is no
    // Microsoft.AspNetCore.Mvc.Testing reference. The TodoListsController is a thin
    // pass-through to MediatR (see src/WebUI/Controllers/TodoListsController.cs), so we
    // characterize behavior at the MediatR boundary using the existing Testing fixture
    // (the explicit reference pattern named in the ticket). HTTP semantics produced by
    // the controller are recorded in comments alongside each test.
    public class TodoListsApiTests : TestBase
    {
        // GET /api/TodoLists -> 200 OK with TodosVm { PriorityLevels, Lists }
        [Test]
        public async Task Get_ReturnsTodosVmShape_WhenNoLists()
        {
            await RunAsDefaultUserAsync();

            var vm = await SendAsync(new GetTodosQuery());

            vm.Should().NotBeNull();
            vm.Should().BeOfType<TodosVm>();
            vm.PriorityLevels.Should().NotBeNull();
            vm.PriorityLevels.Should().NotBeEmpty();
            vm.PriorityLevels.First().Should().BeOfType<PriorityLevelDto>();
            vm.Lists.Should().NotBeNull();
            vm.Lists.Should().BeEmpty();
        }

        // GET /api/TodoLists -> 200 OK with TodosVm whose Lists are projected via TodoListDto
        [Test]
        public async Task Get_ReturnsTodoListDtoShape_WhenListsExist()
        {
            await RunAsDefaultUserAsync();

            await SendAsync(new CreateTodoListCommand { Title = "Shopping" });
            await SendAsync(new CreateTodoListCommand { Title = "Chores" });

            var vm = await SendAsync(new GetTodosQuery());

            vm.Lists.Should().HaveCount(2);
            // Verify ordering is alphabetical by Title — characterizes the OrderBy(t => t.Title)
            // in GetTodosQueryHandler so that future cleanup cannot silently drop it.
            vm.Lists.Select(l => l.Title).Should().ContainInOrder("Chores", "Shopping");

            var first = vm.Lists.First();
            first.Should().BeOfType<TodoListDto>();
            first.Id.Should().BeGreaterThan(0);
            first.Title.Should().NotBeNullOrEmpty();
            first.Items.Should().NotBeNull();
        }

        // POST /api/TodoLists -> 200 OK with int (the new list id)
        [Test]
        public async Task Create_ReturnsIntId_AndPersistsList()
        {
            var userId = await RunAsDefaultUserAsync();

            var command = new CreateTodoListCommand { Title = "Tasks" };

            var id = await SendAsync(command);

            id.Should().BeOfType(typeof(int)).And.NotBe(0);
            id.Should().BeGreaterThan(0);

            var list = await FindAsync<TodoList>(id);
            list.Should().NotBeNull();
            list.Title.Should().Be(command.Title);
            list.CreatedBy.Should().Be(userId);
        }

        // POST /api/TodoLists -> 400 BadRequest (ValidationException) when Title is empty
        [Test]
        public void Create_ThrowsValidationException_WhenTitleMissing()
        {
            FluentActions.Invoking(() =>
                SendAsync(new CreateTodoListCommand()))
                .Should().Throw<ValidationException>();
        }

        // POST /api/TodoLists -> 400 BadRequest when title duplicates an existing list
        [Test]
        public async Task Create_ThrowsValidationException_OnDuplicateTitle()
        {
            await SendAsync(new CreateTodoListCommand { Title = "Shopping" });

            FluentActions.Invoking(() =>
                SendAsync(new CreateTodoListCommand { Title = "Shopping" }))
                .Should().Throw<ValidationException>();
        }

        // PUT /api/TodoLists/{id} -> 204 NoContent on success (controller returns NoContent
        // when MediatR Send completes without throwing)
        [Test]
        public async Task Update_ReturnsNoContentSemantics_AndPersistsTitle()
        {
            await RunAsDefaultUserAsync();

            var listId = await SendAsync(new CreateTodoListCommand { Title = "Original" });

            var command = new UpdateTodoListCommand
            {
                Id = listId,
                Title = "Renamed"
            };

            // Update returns Unit (no payload). The WebUI controller maps this to 204 NoContent.
            var result = await SendAsync(command);
            result.Should().Be(MediatR.Unit.Value);

            var list = await FindAsync<TodoList>(listId);
            list.Title.Should().Be("Renamed");
        }

        // PUT /api/TodoLists/{id} -> 404 NotFound when id does not exist
        [Test]
        public void Update_ThrowsNotFoundException_WhenListMissing()
        {
            var command = new UpdateTodoListCommand
            {
                Id = 99,
                Title = "Anything"
            };

            FluentActions.Invoking(() =>
                SendAsync(command))
                .Should().Throw<NotFoundException>();
        }

        // DELETE /api/TodoLists/{id} -> 204 NoContent on success
        [Test]
        public async Task Delete_ReturnsNoContentSemantics_AndRemovesList()
        {
            var listId = await SendAsync(new CreateTodoListCommand { Title = "Disposable" });

            var result = await SendAsync(new DeleteTodoListCommand { Id = listId });
            result.Should().Be(MediatR.Unit.Value);

            var list = await FindAsync<TodoList>(listId);
            list.Should().BeNull();
        }

        // DELETE /api/TodoLists/{id} -> 404 NotFound when id does not exist
        [Test]
        public void Delete_ThrowsNotFoundException_WhenListMissing()
        {
            FluentActions.Invoking(() =>
                SendAsync(new DeleteTodoListCommand { Id = 99 }))
                .Should().Throw<NotFoundException>();
        }
    }
}
