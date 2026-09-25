import { AnalyticsService } from '../../services/analytics.ts';
import type { Web } from '../app.ts';
import { badge, card, grid, html, inr, kv, table, when } from '../ui.ts';

export function registerDashboard(web: Web): void {
  const s = web.studio;
  web.router.get('/', (req) => {
    const simulated = s.env.mockGeneration;
    const budget = s.budget.status(simulated);
    const stats = new AnalyticsService(s).production(simulated);
    const projects = s.projects.list();
    const activeJobs = s.jobs.list({ status: 'active' });
    const activeGpus = s.gpuRepo.active();
    const recent = s.jobs.recentAttempts(8);
    const body = html` ${grid([
      card(
        'Projects',
        html`<p class="big">${projects.length}</p>
          <a href="/projects">Open projects →</a>`,
      ),
      card(
        'Generation queue',
        html`<p class="big">${activeJobs.length}</p>
          <p class="muted">waiting / running jobs</p>
          <a href="/queue">Open queue →</a>`,
      ),
      card(
        `GPU budget${simulated ? ' (simulated)' : ''}`,
        html`${badge(budget.level)}
        ${kv([
          [
            'Today',
            `${inr(budget.daily.spentInr)} of ${inr(budget.daily.limitInr)} (${budget.daily.percent}%)`,
          ],
          [
            'This month',
            `${inr(budget.monthly.spentInr)} of ${inr(budget.monthly.limitInr)} (${budget.monthly.percent}%)`,
          ],
        ])}${budget.messages.map((m) => html`<p class="muted">${m}</p>`)}`,
      ),
      card(
        'GPU instances',
        html`<p class="big">${activeGpus.length}</p>
          <p class="muted">${activeGpus.length ? 'active — see GPU & Costs' : 'none running'}</p>
          <a href="/gpu">GPU & Costs →</a>`,
      ),
    ])}
    ${card(
      `Production${simulated ? ' (mock / simulated numbers)' : ''}`,
      kv([
        ['Finished videos', stats.videosProduced],
        ['Finished minutes', stats.finishedMinutes],
        ['Shots generated', stats.shotsGenerated],
        ['Approval rate', `${stats.approvalRate}%`],
        ['Attempts per approved shot', stats.attemptsPerApprovedShot],
        ['Cost per finished minute', inr(stats.costPerFinishedMinuteInr)],
        ['Similarity warnings', stats.similarityWarnings],
      ]),
    )}
    ${card(
      'Recent generation attempts',
      table(
        ['When', 'Kind', 'Model', 'Status', 'Approval', 'Cost'],
        recent.map((a) => [
          when(a.created_at),
          a.shot_id ? html`<a href="/shots/${a.shot_id}">${a.kind}</a>` : a.kind,
          a.model,
          badge(a.status),
          badge(a.approval),
          `${inr(a.estimated_cost_inr)}${a.is_mock ? ' (sim)' : ''}`,
        ]),
      ),
    )}
    ${card(
      'Workflow',
      html`<ol class="workflow">
        <li>Create or import a story (<a href="/stories/import">Story Package import</a>)</li>
        <li>Add characters, references and voices; lock approved identities</li>
        <li>Review scenes and shots; generate and approve images (image-first)</li>
        <li>Animate approved images; review good / bad clips</li>
        <li>BUILD FINAL → quality check → human review → export</li>
      </ol>`,
    )}`;
    return web.render(req, 'Dashboard', '/', body);
  });
}
