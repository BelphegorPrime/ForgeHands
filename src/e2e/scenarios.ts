// The built-in scenarios: data in the format of format.ts, checked when this module loads. Scenarios 1 and 2 are deterministic on a test
// repository set up as docs/e2e.md describes. Scenarios 3 to 5 depend on what the agents do, so they are experimental: they run only when
// E2E_SCENARIOS names them, and their precondition says what has to be true for the outcome to be the one they expect.
import { parseScenario, type Scenario } from './format.ts';

const RED_MARKER = 'e2e/red.marker';

export const SCENARIOS: Scenario[] = [
  parseScenario({
    name: 'normal-delivery',
    title: 'Normal delivery',
    description: 'A ticket with the worker label becomes a pull request, which is reviewed, merged, and closes the ticket.',
    experimental: false,
    precondition: null,
    steps: [
      { do: 'ticket', as: 'ticket', label: 'ai:ready', title: 'E2E normal delivery',
        body: '## Files\n- e2e/delivery.txt (new)\n\n## Steps\n1. Create the file e2e/delivery.txt with the single line "delivered".\n2. Change nothing else.\n\n'
          + '## Acceptance\n```sh\ntest "$(cat e2e/delivery.txt)" = "delivered"\n```' },
      { do: 'wait', as: 'pr', timeoutMinutes: 30, for: { findPull: 'ai/issue-$ticket' } },
      { do: 'wait', timeoutMinutes: 45, for: { pull: '$pr', state: 'merged' } },
      { do: 'assert', that: { pull: '$pr', comment: { contains: 'Verdict: OK' } }, message: 'the review verdict is missing' },
      { do: 'wait', timeoutMinutes: 10, for: { issue: '$ticket', state: 'closed' } },
    ],
  }),
  parseScenario({
    name: 'revert-on-red',
    title: 'Revert on red',
    description: 'A merged change turns the default branch red. ForgeHands reverts it, reopens the ticket with the cause, starts it once more, and does not start it a second time.',
    experimental: false,
    precondition: null,
    steps: [
      // The test repository's CI fails on the default branch while RED_MARKER exists (docs/e2e.md); the pull request itself stays green.
      { do: 'ticket', as: 'ticket', label: 'ai:ready', title: 'E2E revert on red',
        body: '## Files\n- ' + RED_MARKER + ' (new)\n\n## Steps\n1. Create the file ' + RED_MARKER + ' with the single line "red".\n2. Change nothing else.\n\n'
          + '## Acceptance\n```sh\ntest "$(cat ' + RED_MARKER + ')" = "red"\n```\n\n'
          + '## Notes\nThe default branch is meant to turn red after this change: the test repository\'s CI fails on main while the marker file exists. '
          + 'That red is intended; do not remove the marker file.' },
      { do: 'wait', as: 'pr', timeoutMinutes: 30, for: { findPull: 'ai/issue-$ticket' } },
      { do: 'wait', timeoutMinutes: 45, for: { pull: '$pr', state: 'merged' } },
      { do: 'wait', timeoutMinutes: 20, for: { mergeCommit: '$pr', status: 'failure' } },
      { do: 'wait', as: 'revert', timeoutMinutes: 45, for: { findPull: 'ai/revert-$pr', state: 'merged' } },
      { do: 'wait', timeoutMinutes: 10, for: { issue: '$ticket', state: 'open' } },
      { do: 'wait', timeoutMinutes: 5, for: { issue: '$ticket', comment: { contains: 'was reverted by #$revert', min: 1, max: 1 } } },
      // The revert's restart is the run whose event carries the revert_retry marker (Dispatcher.revertMerged). A hand-back escalation after it
      // (ai:escalate) is another run and is allowed: the notes of the result list every run.
      { do: 'wait', timeoutMinutes: 15, for: { revertRestarts: '$ticket', atLeast: 1 } },
      { do: 'settle', seconds: 180 },
      { do: 'assert', that: { revertRestarts: '$ticket', exactly: 1 }, message: 'the revert did not restart the ticket exactly once' },
      { do: 'assert', that: { issue: '$ticket', comment: { contains: 'was reverted by #$revert', min: 1, max: 1 } }, message: 'the cause was not commented exactly once' },
      { do: 'wait', timeoutMinutes: 20, for: { branch: 'default', status: 'success' } },
    ],
  }),
  parseScenario({
    name: 'empty-runs',
    title: 'Empty runs escalate once, then a human',
    description: 'A worker that delivers nothing twice escalates once to the stronger route; when that run delivers nothing either, a human is called.',
    experimental: true,
    precondition: 'The ticket must be one the worker cannot deliver (its body asks for an action the agent cannot take, and says so). The route ai:escalate must exist '
      + 'with "escalate_to" on ai:ready, and the human hand-over must put the label ai:blocked on the ticket (assumed: check it on your instance).',
    steps: [
      { do: 'ticket', as: 'ticket', label: 'ai:ready', title: 'E2E empty runs',
        body: '## Files\n- none\n\n## Steps\n1. Fetch the answer from the address named in Acceptance and post it as a comment on this ticket.\n'
          + '2. If the agent cannot reach that address, say so in a comment and open no pull request. This ticket is a test of an empty run.\n\n'
          + '## Acceptance\n```sh\ncurl -fsS --max-time 10 https://answer.e2e.invalid/42 | grep -qx 42\n```' },
      { do: 'wait', timeoutMinutes: 60, for: { runs: '$ticket', label: 'ai:ready', atLeast: 2 } },
      { do: 'wait', timeoutMinutes: 60, for: { runs: '$ticket', label: 'ai:escalate', atLeast: 1 } },
      { do: 'wait', timeoutMinutes: 30, for: { issue: '$ticket', hasLabel: 'ai:blocked' } },
      { do: 'settle', seconds: 120 },
      { do: 'assert', that: { runs: '$ticket', label: 'ai:escalate', exactly: 1 }, message: 'the escalation ran more than once' },
    ],
  }),
  parseScenario({
    name: 'stuck-pull-request',
    title: 'Stuck pull request is blocked once',
    description: 'A pull request whose reviewer keeps saying NOT OK on an unchanged head is blocked for a human by the stuck-PR watchdog, and not merged.',
    experimental: true,
    precondition: 'STUCK_PR_MINUTES must be small on the instance (for example 5), and the ticket asks for something that cannot be met, so the reviewer says NOT OK on '
      + 'the same head. The block puts the label ai:blocked on the pull request (assumed: check it on your instance).',
    steps: [
      { do: 'ticket', as: 'ticket', label: 'ai:ready', title: 'E2E stuck pull request',
        body: '## Files\n- e2e/impossible.txt (new)\n\n## Steps\n1. Make the file e2e/impossible.txt exist.\n'
          + '2. Make the file e2e/impossible.txt not exist, at the same time as step 1. This cannot be met: say so in the pull request.\n\n'
          + '## Acceptance\n```sh\ntest -f e2e/impossible.txt && test ! -e e2e/impossible.txt\n```' },
      { do: 'wait', as: 'pr', timeoutMinutes: 30, for: { findPull: 'ai/issue-$ticket' } },
      { do: 'wait', timeoutMinutes: 45, for: { pull: '$pr', comment: { contains: 'Verdict: NOT OK', min: 1 } } },
      { do: 'wait', timeoutMinutes: 30, for: { pull: '$pr', hasLabel: 'ai:blocked' } },
      { do: 'settle', seconds: 120 },
      { do: 'assert', that: { pull: '$pr', state: 'open' }, message: 'a blocked pull request was merged' },
    ],
  }),
  parseScenario({
    name: 'conflict-round',
    title: 'Conflict round',
    description: 'Two tickets change the same file. The second pull request conflicts once the first is merged, and a conflict round is started for its ticket.',
    experimental: true,
    precondition: 'LABEL_ROUTES must have a route ai:conflict with "on": "conflict", WAIT_FOR_SAME_FILES must be off (both tickets then start at once), and the '
      + 'route label ai:conflict is what a run of this kind is recorded under (assumed: check it on your instance).',
    steps: [
      { do: 'ticket', as: 'first', label: 'ai:ready', title: 'E2E conflict first',
        body: '## Exact files\n- e2e/conflict.txt (new)\n\n## Steps\n1. Set the file e2e/conflict.txt to the single line "first".\n\n'
          + '## Acceptance\n```sh\ntest "$(cat e2e/conflict.txt)" = "first"\n```' },
      { do: 'ticket', as: 'second', label: 'ai:ready', title: 'E2E conflict second',
        body: '## Exact files\n- e2e/conflict.txt (new)\n\n## Steps\n1. Set the file e2e/conflict.txt to the single line "second".\n\n'
          + '## Acceptance\n```sh\ntest "$(cat e2e/conflict.txt)" = "second"\n```' },
      { do: 'wait', as: 'firstPr', timeoutMinutes: 30, for: { findPull: 'ai/issue-$first' } },
      { do: 'wait', as: 'secondPr', timeoutMinutes: 30, for: { findPull: 'ai/issue-$second' } },
      { do: 'wait', timeoutMinutes: 45, for: { pull: '$firstPr', state: 'merged' } },
      { do: 'wait', timeoutMinutes: 45, for: { runs: '$second', label: 'ai:conflict', atLeast: 1 } },
      { do: 'settle', seconds: 120 },
      { do: 'assert', that: { runs: '$second', label: 'ai:conflict', exactly: 1 }, message: 'the conflict round ran more than once' },
    ],
  }),
];

export const SCENARIO_NAMES: string[] = SCENARIOS.map((scenario) => scenario.name);

/** The scenarios a run takes: the named ones in the order given, or every non-experimental one. Unknown names are the caller's error. */
export function selectScenarios(names: string[] | null): Scenario[] {
  if (names === null) return SCENARIOS.filter((scenario) => !scenario.experimental);
  return names.map((name) => SCENARIOS.find((scenario) => scenario.name === name)).filter((scenario): scenario is Scenario => Boolean(scenario));
}
