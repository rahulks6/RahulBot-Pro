import { createStudio } from '../app/studio.ts';
import { seedDemo } from '../demo/seed.ts';

// Seed the Phase 1 demo project (mock mode only; spends ₹0).
const studio = createStudio({ logSinks: [] });
try {
  const result = await seedDemo(studio, (m) => console.log(`• ${m}`));
  console.log('\nDemo ready:', JSON.stringify(result, null, 2));
  console.log(`\nStart the app with "npm run dev" and open http://${studio.env.host}:${studio.env.port}/`);
} catch (err) {
  console.error('Demo seed failed:', err);
  process.exitCode = 1;
} finally {
  studio.close();
}
