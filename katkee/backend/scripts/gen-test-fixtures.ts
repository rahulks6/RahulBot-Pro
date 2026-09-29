/** Ad hoc helper for manual smoke-testing media uploads with curl — not part of the app. */
import * as fs from "node:fs";
import { buildTestPng, buildTestJpeg, buildTestMp4 } from "../test/fixtures";

const outDir = "/tmp/katkee-fixtures";
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(`${outDir}/test.png`, buildTestPng(4, 3));
fs.writeFileSync(`${outDir}/test.jpg`, buildTestJpeg(4, 3));
fs.writeFileSync(`${outDir}/test.mp4`, buildTestMp4());
console.log(`fixtures written to ${outDir}`);
