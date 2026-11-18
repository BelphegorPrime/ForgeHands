import type { NotifyLanguage } from '../types.ts';
import type { Notification } from './channel.ts';
import { esc, shortRepo } from './texts.ts';

// The notice that a repository has no CI (CHECKS_FROM_CI): sent once per repository and process, as NOTIFY_IMMEDIATE kind `checks`.
// Fixed strings and the repository and commit only.
export function checksMessage(language: NotifyLanguage, repository: string, sha: string): Notification {
  const de = language === 'de';
  const commit = sha.slice(0, 8);
  const subject = de ? 'ForgeHands: ' + shortRepo(repository) + ' hat kein CI' : 'ForgeHands: ' + shortRepo(repository) + ' has no CI';
  const lines = de
    ? ['Auf Commit ' + commit + ' von ' + repository + ' läuft kein Workflow und meldet kein Prüfergebnis. ForgeHands hat dafür kein Ergebnis.',
      'Ohne Prüfergebnis kann ForgeHands einen Commit, der den Standardbranch rot macht, nicht zurücknehmen (REVERT_ON_RED), und eine Änderung nicht prüfen: dort beurteilt der Reviewer nur den Code.',
      'Ein CI-Workflow im Repository behebt das. Diese Meldung kommt einmal pro Repository (CHECKS_FROM_CI=0 schaltet die Prüfung ab).']
    : ['No workflow runs on commit ' + commit + ' of ' + repository + ' and no check reports on it, so ForgeHands has no check result for it.',
      'Without a check result ForgeHands cannot revert a commit that breaks the default branch (REVERT_ON_RED) and cannot verify a change: there the reviewer judges the code alone.',
      'A CI workflow in the repository fixes this. This notice comes once per repository (CHECKS_FROM_CI=0 switches the check off).'];
  const html = '<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5">'
    + '<p style="margin:0 0 8px;font-size:16px;font-weight:600">' + esc(subject) + '</p><p style="margin:0">' + lines.map(esc).join('<br>') + '</p></body></html>';
  return { kind: 'checks', subject, text: lines.join('\n'), html };
}
