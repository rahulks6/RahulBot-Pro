/**
 * Per-build environment config, selected automatically by `__DEV__` —
 * React Native's own built-in global (true in a Metro/debug build, false
 * in a release build), so there's no extra native module or `.env` file
 * needed just to pick a backend URL. This is deliberately the minimal
 * real solution: `react-native-config` (or Expo's `app.config.js` `extra`
 * fields) is the natural next step if you outgrow two tiers — e.g. a
 * separate staging environment for TestFlight/Play internal-testing
 * builds — but that needs native setup this project doesn't have yet
 * (no ios/android folders exist until you bootstrap the RN project — see
 * DEPLOYMENT.md), so it's not forced on you before you need it.
 *
 * The dev URL differs by *how* you're running the app, not just that
 * you're in dev — this hasn't changed and still needs a manual edit
 * below depending on your target:
 *   - iOS Simulator: http://localhost:4000 (can reach the host directly)
 *   - Android Emulator: http://10.0.2.2:4000 (emulator's alias for the host)
 *   - A physical device on the same Wi-Fi: http://<your-machine's-LAN-IP>:4000
 */
interface AppEnv {
  apiBaseUrl: string;
}

const development: AppEnv = {
  apiBaseUrl: "http://localhost:4000",
};

const production: AppEnv = {
  // Replace with your real deployed backend's HTTPS domain (see
  // backend/DEPLOYMENT.md) before making a release build — iOS blocks
  // plain HTTP by default (App Transport Security), so this must be
  // `https://`, not `http://`.
  apiBaseUrl: "https://api.yourapp.example.com",
};

export const appEnv: AppEnv = __DEV__ ? development : production;
