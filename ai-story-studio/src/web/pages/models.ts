import { AppError } from '../../lib/errors.ts';
import { classify } from '../../services/hardware.ts';
import type { LocalModelStatus, LocalModelView } from '../../services/local-models.ts';
import type { ModelCategory } from '../../services/model-manager.ts';
import type { ExecutionSettings } from '../../services/settings.ts';
import type { Web } from '../app.ts';
import { badge, button, card, field, html, kv, postForm, table } from '../ui.ts';

const STATUS_KIND: Record<LocalModelStatus, string> = {
  READY: 'good',
  'BUILT IN': 'good',
  INSTALLED: 'neutral',
  'NOT INSTALLED': 'neutral',
  DOWNLOADING: 'warn',
  BROKEN: 'bad',
};

const FIT_KIND = { fits: 'good', cpu: 'good', offload: 'warn', too_big: 'bad', no_gpu: 'bad' } as const;

const TASK: Record<ModelCategory, string> = {
  text: 'Story writing',
  image: 'Image',
  video: 'Image-to-video',
  tts: 'Text-to-speech',
  music: 'Music',
  sfx: 'SFX / ambience',
  upscale: 'Upscaler',
  lipsync: 'Lip-sync',
};

const SETTING_FOR: Partial<Record<ModelCategory, keyof ExecutionSettings>> = {
  image: 'imageModel',
  video: 'videoModel',
  tts: 'ttsModel',
  upscale: 'upscaler',
  music: 'musicModel',
  sfx: 'sfxModel',
};

export const gbText = (bytes: number): string =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;

export function registerModelPages(web: Web): void {
  const s = web.studio;
  const r = web.router;
  const lm = s.localModels;
  const catalog = s.router.localCatalog;

  async function views(): Promise<{ list: LocalModelView[]; usable: number; hasGpu: boolean }> {
    const hw = classify(await s.hardware.nvidia(), s.hardware.torch, {
      maxVramPercent: s.settings.get('execution').maxVramPercent,
    });
    return {
      list: lm.views({ usableVramGb: hw.usableVramGb, hasGpu: hw.device !== null }),
      usable: hw.usableVramGb,
      hasGpu: hw.device !== null,
    };
  }

  r.get('/models', async (req) => {
    const { list, usable, hasGpu } = await views();
    const ex = s.settings.get('execution');
    const plan = lm.plan.bind(lm);
    const free = (() => {
      try {
        return plan(list.find((m) => m.repo)?.id ?? '').freeGb;
      } catch {
        return null;
      }
    })();
    const inUse = (m: LocalModelView): boolean => {
      const key = SETTING_FOR[m.type];
      return key ? ex[key] === m.id : false;
    };
    const tokenSource = s.secrets.source('hfToken');
    return web.render(
      req,
      'Model Manager',
      '/models',
      html`<p class="muted">
          Models for <strong>LOCAL GPU</strong> mode (this computer). Nothing downloads until you press
          Install and confirm; generation never downloads. Cloud models are managed on the
          <a href="/cloud">Cloud GPU</a> page.
        </p>
        ${card(
          'Where models are stored',
          kv([
            ['Model folder (MODEL_CACHE_PATH)', lm.cacheDir],
            ['Free space there', free === null ? 'unknown' : `${free} GB`],
            [
              'This GPU',
              hasGpu ? `${usable} GB usable VRAM (Settings → Max VRAM usage)` : 'no NVIDIA GPU detected',
            ],
            [
              'Hugging Face token (gated models only)',
              tokenSource === 'none'
                ? 'not saved'
                : `${s.secrets.masked('hfToken')} (${tokenSource === 'env' ? 'from .env' : 'saved in the app'})`,
            ],
          ]),
          html`${postForm(
            '/models/hf-token',
            html`${field('Save a Hugging Face read token', 'hf_token', '', {
                type: 'password',
                placeholder: 'hf_…',
              })}<button>Save token</button>`,
          )}`,
        )}
        ${card(
          'Models',
          table(
            [
              'Model',
              'Task',
              'Status',
              'Disk',
              'VRAM (min / offload / comfortable)',
              'This GPU',
              'Licence',
              '',
            ],
            list.map((m) => [
              html`<strong>${m.name}</strong>${inUse(m) ? html` ${badge('selected', 'good')}` : ''}<br /><small
                  class="muted"
                  >${m.id} · ${m.backend}${m.repo ? html` · ${m.repo}` : ''}</small
                >`,
              TASK[m.type],
              html`${badge(m.status, STATUS_KIND[m.status])}${m.status === 'DOWNLOADING' && m.lastDownload
                ? html`<br /><small
                      >${gbText(m.lastDownload.bytes_done)} of
                      ~${gbText(m.lastDownload.bytes_expected)}</small
                    >`
                : m.status === 'BROKEN'
                  ? html`<br /><small>incomplete — Install resumes it</small>`
                  : m.lastDownload?.status === 'failed' || m.lastDownload?.status === 'cancelled'
                    ? html`<br /><small>${m.lastDownload.error_message ?? ''}</small>`
                    : ''}`,
              m.repo ? `${m.diskBytes ? gbText(m.diskBytes) : '0'} / ~${m.storageGb} GB` : 'none (built in)',
              m.minVramGb === 0
                ? 'CPU'
                : `${m.minVramGb} / ${m.offloadMinVramGb || m.minVramGb} / ${m.recommendedVramGb} GB`,
              html`${badge(m.fit.replace('_', ' '), FIT_KIND[m.fit])}<br /><small>${m.fitText}</small>`,
              html`${m.license}<br /><small
                  >${m.commercialUse === 'conditional'
                    ? m.licenseAcknowledged
                      ? 'conditions acknowledged'
                      : 'conditions — read and acknowledge'
                    : m.commercialUse}</small
                >`,
              html`<div class="row">
                ${m.status === 'DOWNLOADING'
                  ? button(`/models/${m.id}/cancel`, 'Cancel download')
                  : m.repo && m.status !== 'READY' && m.status !== 'INSTALLED'
                    ? html`<a class="button primary" href="/models/${m.id}/install">
                        ${m.status === 'BROKEN' ? 'Resume install' : 'Install'}</a
                      >`
                    : ''}
                ${m.commercialUse === 'conditional'
                  ? button(
                      `/models/${m.id}/license`,
                      m.licenseAcknowledged ? 'Withdraw acknowledgement' : 'Acknowledge licence',
                      {
                        acknowledged: m.licenseAcknowledged ? 'false' : 'true',
                      },
                    )
                  : ''}
                ${button(`/models/${m.id}/enable`, m.enabled ? 'Disable' : 'Enable', {
                  enabled: m.enabled ? 'false' : 'true',
                })}
                ${SETTING_FOR[m.type] && !inUse(m) && m.usable
                  ? button(`/models/${m.id}/use`, `Use for ${TASK[m.type].toLowerCase()}`)
                  : ''}
                ${m.repo && m.diskBytes > 0 && m.status !== 'DOWNLOADING'
                  ? html`<a class="button danger" href="/models/${m.id}/delete">Delete files</a>`
                  : ''}
              </div>`,
            ]),
          ),
          html`<a class="button" href="/models">Refresh</a>`,
        )}
        <p class="muted">
          VRAM figures are planning values. "Only with sequential CPU offload" works but is much slower. See
          docs/MODEL_SETUP.md for disk and VRAM guidance.
        </p>`,
    );
  });

  r.get('/models/:id/install', async (req) => {
    const p = lm.plan(req.params['id']!);
    const remaining = Math.max(0, p.expectedBytes - p.alreadyBytes);
    return web.render(
      req,
      `Install ${p.model.name}?`,
      '/models',
      html`${card(
        'Confirm the download',
        html`${kv([
            ['Model', p.model.name],
            ['From', p.repos.map((x) => `huggingface.co/${x.repo}`).join(' + ')],
            ['Download size', `about ${p.model.storageGb} GB`],
            ['Already on disk', gbText(p.alreadyBytes)],
            ['Still to download', `about ${gbText(remaining)}`],
            ['Saved to', p.cacheDir],
            ['Free space there', p.freeGb === null ? 'unknown' : `${p.freeGb} GB`],
            ['Licence', `${p.model.license} (${p.model.commercialUse})`],
          ])}
          ${p.model.licenseNotes ? html`<p class="muted">${p.model.licenseNotes}</p>` : ''}
          ${p.gated && s.secrets.source('hfToken') === 'none'
            ? html`<p class="flash error">
                This repository is gated: accept its terms on huggingface.co and save a Hugging Face token on
                the Model Manager page first.
              </p>`
            : ''}
          ${p.enoughSpace
            ? postForm(
                `/models/${p.model.id}/install`,
                html`<input type="hidden" name="confirm" value="yes" /><button class="primary">
                    Download about ${gbText(remaining)} now
                  </button>
                  <a class="button" href="/models">Cancel</a>`,
              )
            : html`<p class="flash error">
                  Not enough free space (${p.freeGb} GB free, about ${p.model.storageGb} GB needed). Set
                  MODEL_CACHE_PATH in .env to a bigger drive (docs/MODEL_SETUP.md), restart, then try again.
                </p>
                <a class="button" href="/models">Back</a>`}
          <p class="muted">The download can be cancelled; Install later resumes from where it stopped.</p>`,
      )}`,
    );
  });

  r.post('/models/:id/install', async (req) => {
    if (req.form['confirm'] !== 'yes')
      throw new AppError('PRECONDITION_FAILED', 'Open the install page and confirm the download first.');
    const rec = await lm.install(req.params['id']!);
    return web.redirect('/models', `Download started (${gbText(rec.bytes_expected)}). Progress shows below.`);
  });

  r.post('/models/:id/cancel', (req) => {
    lm.cancel(req.params['id']!);
    return web.redirect('/models', 'Download cancelled. Install resumes it later.');
  });

  r.get('/models/:id/delete', async (req) => {
    const m = (await views()).list.find((x) => x.id === req.params['id']);
    if (!m) throw new AppError('NOT_FOUND', 'Unknown model');
    return web.render(
      req,
      `Delete ${m.name}?`,
      '/models',
      card(
        'Delete model files',
        html`<p>
            This deletes <strong>${gbText(m.diskBytes)}</strong> in ${m.location}. Projects, approved
            references and exports are not affected. You can install the model again later.
          </p>
          ${postForm(
            `/models/${m.id}/delete`,
            html`${field('Type DELETE to confirm', 'confirm', '', { required: true })}
              <button class="danger">Delete the model files</button>
              <a class="button" href="/models">Cancel</a>`,
          )}`,
      ),
    );
  });

  r.post('/models/:id/delete', (req) => {
    if (req.form['confirm'] !== 'DELETE') throw new AppError('VALIDATION_FAILED', 'Type DELETE to confirm.');
    const freed = lm.remove(req.params['id']!, { workerRunning: s.worker !== null });
    return web.redirect('/models', `Deleted ${gbText(freed)}.`);
  });

  r.post('/models/:id/enable', (req) => {
    catalog.setEnabled(req.params['id']!, req.form['enabled'] === 'true');
    return web.redirect('/models', 'Saved. Restart the local worker to apply.');
  });

  r.post('/models/:id/license', (req) => {
    catalog.acknowledgeLicense(req.params['id']!, req.form['acknowledged'] === 'true');
    s.logger.info('local model licence acknowledgement', {
      model: req.params['id'],
      acknowledged: req.form['acknowledged'] === 'true',
    });
    return web.redirect('/models', 'Saved.');
  });

  r.post('/models/:id/use', (req) => {
    const m = catalog.states().find((x) => x.id === req.params['id']);
    if (!m) throw new AppError('NOT_FOUND', 'Unknown model');
    const key = SETTING_FOR[m.type];
    if (!key) throw new AppError('VALIDATION_FAILED', `No setting for ${m.type} models`);
    s.settings.set('execution', { ...s.settings.get('execution'), [key]: m.id });
    return web.redirect(
      '/models',
      `${m.name} will be used for ${TASK[m.type].toLowerCase()} (after a worker restart).`,
    );
  });

  r.post('/models/hf-token', (req) => {
    const token = (req.form['hf_token'] ?? '').trim();
    if (!/^hf_[A-Za-z0-9]{20,}$/.test(token))
      throw new AppError('VALIDATION_FAILED', 'That does not look like a Hugging Face token (hf_…).');
    s.secrets.set('hfToken', token);
    s.logger.info('hugging face token saved');
    return web.redirect('/models', 'Token saved (stored on this PC only).');
  });
}
