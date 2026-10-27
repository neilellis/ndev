# Verification policy

[kb](README.md) › verification-policy

**Verify a change against the surface that it touches, not against its own description.** A test, a review or a gate that comes from the description can only confirm what the author already thought of. The defects that pass CI sit at the edges that the description does not name: a sibling function, a second entry point to the same setting, a promise in the plan that the PR did not deliver.

## Rule 1: list what the change touches

Before you change an invariant (a bound, a refusal, a field name, a wire shape, a durability or ordering rule), list every entry point that reads or writes the same thing:

- setters and constructors;
- HTTP routes and other network handlers;
- each SDK or client, in each language;
- configuration loading and environment overrides;
- scheduled jobs, command-line verbs and examples;
- other packages in the workspace that parse the same format, key layout or message;
- sibling functions of the same shape: the same handler family, the same request builder, the function above and below the one that you changed.

Put the list in the PR, with the search command that found each item (for example `rg -n 'timeout_ms' src/ sdk/`). Test each entry point, or say in the PR why it is out of scope.

The search command is necessary. A list is only as complete as the search behind it. The command lets a reviewer see what you did not search.

### Shared contracts

A change to a shared contract (an on-disk key layout, a wire format, an encoding) can break a package that has its own parser and no test of the round trip. A local gate can stay green while CI goes red ([ci.md](ci.md#a-local-gate-is-not-ci)). Search the whole workspace for other readers of the contract, not only the package that you changed. Add a round-trip test to each reader that you find.

## Rule 2: a plan row closes only on evidence

A plan or delivery row is marked done only when each of its promises is quoted beside the code or the test that delivers it.

- Read the row against the merged diff, not against the PR description.
- If a promise is not delivered, write *not built* in the row. Do not leave it implied.
- A person or an agent who did not write the PR does the check.
- A release does not ship while a row marked done lacks this evidence ([deployment.md](deployment.md#before-you-tag-a-release)).

A row that closes on the PR alone can carry a half-built promise through several releases before an audit finds it.

## Rule 3: CI proves that each test ran

CI finds tests by discovery, not by a list, and it proves that every known test executed. See [ci.md](ci.md#ci-proves-that-each-test-ran).

## Rule 4: an independent adversarial review before merge

Before merge, an agent that did not write the change reviews it. It gets only the diff and the quoted plan row, and it tries to break the change. Its findings are fixed or answered in the PR before merge. The procedure is the [`adversarial-review` skill](../skills/adversarial-review/SKILL.md).

## What this policy does not promise

It does not promise that nothing is missed. It makes each gap visible: the search command shows what was not searched, and the quoted row shows what was not built.
