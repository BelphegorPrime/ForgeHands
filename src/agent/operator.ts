import type { AgentApi } from '../types/forge.ts';
import type { DirectConfig, ForgeEvent } from '../types.ts';

// Operator prerequisites. Some work needs something only a person can provide: a token or a secret to create, a setting of the forge, the package
// registry or the CI runner, an access right, hardware, a decision. Such an item is a ticket of its own, labelled OPERATOR_LABEL (default
// needs:operator), and the tickets that need it depend on it, so they wait. ForgeHands starts no run on such a ticket, lists it for the human
// (status.json waiting_for_human, reason operator_prerequisite) and tells the human once. A worker that finds such a need makes the ticket itself
// (see checkDelivery) and waits instead of being handed back.

// An operator ticket as /status lists it (waiting_for_human): a ticket, not a pull request, with its title.
export interface OperatorEntry { repository: string; issue: number; pr: null; since: number; reason: string; title: string }

// The ticket carries the operator label (the label is part of the event's labels, whatever route label it also carries).
export function isOperatorTicket(event: ForgeEvent, config: DirectConfig): boolean {
  return !event.pull_request && !event.ci && event.type.startsWith('issues.') && (event.issue?.labels || []).includes(config.operatorLabel);
}

// The planner's label: a route of kind issue that is SPLIT_LABEL or an EPIC_LABEL (the same test as Dispatcher.isPlannerLabel).
export function isPlannerRoute(config: DirectConfig, label: string | undefined): boolean {
  if (!label) return false;
  return config.routes.get(label)?.kind === 'issue' && (label === config.splitLabel || config.epicLabels.has(label));
}

// The lines of a planner's prompt: before it splits the plan, it creates a ticket for every operator prerequisite and makes the work depend on it.
export function operatorPlannerLines(config: DirectConfig, agent: AgentApi): string[] {
  const label = config.operatorLabel;
  const create = agent.issues ? 'POST ' + agent.issues() + ' with ' + (agent.issueCreateBody ?? 'the title, the body and the label') : 'create it in the forge';
  const lines = [
    'Operator prerequisites come first, before you split anything. List what the plan needs that an agent cannot do with its own credentials: a secret or token to create or store, a setting in the forge, the package registry or the CI runner, an access right, hardware, or a decision only a person can make. Code, tests and documentation are never on that list.',
    'For each such item create ONE ticket: ' + create + '. Its title is "Operator: <what>", its only label is "' + label + '" (find the label with GET ' + agent.labels() + ' and create it when it is missing), and its body says exactly what the operator has to do and how to verify it. Do not give it a route label.'
  ];
  if (agent.dependencyAdd) {
    lines.push('Then make every worker ticket that needs the item depend on the operator ticket: POST ' + agent.dependencyAdd('<worker ticket>') + ' with ' + (agent.dependencyBody ?? 'the operator ticket as the index') + '. A ticket that depends on an open operator ticket does not start until that ticket is closed, so no worker runs before the prerequisite is done.');
  } else {
    lines.push('This forge has no dependency API for agents: write into the body of every worker ticket that needs the item "Waits for operator ticket #<n>: do not start before it is closed.", so the worker reads it.');
  }
  lines.push('Create no worker ticket for a step that needs an operator item without that dependency. Never add a route label to an operator ticket: ForgeHands starts no run on it.');
  return lines;
}

// The lines of a worker's prompt: a need only the operator can meet is a ticket of its own, this ticket depends on it, and the run ends without a retry.
export function operatorWorkerLines(config: DirectConfig, agent: AgentApi, number: number): string[] {
  const label = config.operatorLabel;
  const find = agent.issues ? 'GET ' + agent.issues() + '?state=open&labels=' + encodeURIComponent(label) + ' lists the open operator tickets.' : '';
  const lines = [
    'If your ticket needs something only the operator can provide (a secret or token to create, a setting of the forge, the package registry or the CI runner, an access right, hardware, a decision), and no open ticket labelled "' + label + '" covers it, do not try to work around it and do not retry. ' + find,
    'Then create the operator ticket (unless one covers it: then use that one) with ' + (agent.issueCreateBody ?? 'a title, a body and the label') + ': title "Operator: <what>", label "' + label + '" only (create the label the same way when it is missing), a body that says exactly what to do and how to verify it.'
  ];
  if (agent.dependencyAdd) {
    lines.push('Make your own ticket depend on it: POST ' + agent.dependencyAdd(number) + ' with ' + (agent.dependencyBody ?? 'the operator ticket as the index') + '. Then comment once on your ticket: what the operator must do, and the number of the operator ticket. Finish the run right after that comment.');
  } else {
    lines.push('This forge has no dependency API for agents: comment once on your ticket with what the operator must do and the number of the operator ticket, and finish the run right after that comment.');
  }
  lines.push('Do not push a branch for that step and do not start the work that waits for it. ForgeHands holds your ticket until the operator ticket is closed and then runs you again.');
  return lines;
}
