import { loadDotEnv, readEnv } from '../config/env.ts';
import { checkImagePullable, IMAGE_STATUS_LABEL } from '../services/image-check.ts';
import { DEFAULT_SETTINGS } from '../services/settings.ts';

/**
 * npm run check:image [-- <image>]
 *
 * Checks, WITHOUT any credential, whether RunPod will be able to pull the worker image — the same
 * check as the dry-run diagnostics. Exit code 0 only for "IMAGE EXISTS AND PUBLICLY PULLABLE".
 * Image: the argument, else CLOUD_WORKER_IMAGE from .env, else the app's default.
 */
loadDotEnv();
const image = process.argv[2]?.trim() || readEnv().cloudWorkerImage || DEFAULT_SETTINGS.cloud.workerImage;
const result = await checkImagePullable(image);
console.log(`${IMAGE_STATUS_LABEL[result.status]}\n  ${result.detail}`);
if (result.digest) console.log(`  digest: ${result.digest}`);
process.exitCode = result.status === 'PUBLIC' ? 0 : result.status === 'UNREACHABLE' ? 2 : 1;
