import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const STANDARD_RUNTIME = Object.freeze({
  viewport: Object.freeze({ width: 1920, height: 1080 }),
  deviceScaleFactor: 1,
  locale: "zh-CN",
  timezoneId: "Asia/Shanghai",
  browserZoom: 1
});

export const STANDARD_LAUNCH_ARGS = Object.freeze([
  "--window-size=1920,1080",
  "--force-device-scale-factor=1",
  "--lang=zh-CN",
  "--disable-extensions",
  "--disable-features=Translate,AutofillServerCommunication,PasswordManagerOnboarding",
  "--disable-popup-blocking"
]);

export function standardContextOptions(overrides = {}) {
  return {
    viewport: { ...STANDARD_RUNTIME.viewport },
    deviceScaleFactor: STANDARD_RUNTIME.deviceScaleFactor,
    locale: STANDARD_RUNTIME.locale,
    timezoneId: STANDARD_RUNTIME.timezoneId,
    acceptDownloads: true,
    ...overrides
  };
}

export async function pageEnvironment(page) {
  return page.evaluate(() => ({
    url: location.href,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight
    },
    devicePixelRatio: window.devicePixelRatio,
    visualViewportScale: window.visualViewport?.scale ?? 1,
    locale: navigator.language,
    languages: Array.from(navigator.languages || []),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  }));
}

export function validateStandardEnvironment(snapshot) {
  const issues = [];
  const expected = STANDARD_RUNTIME;

  if (snapshot.viewport?.width !== expected.viewport.width || snapshot.viewport?.height !== expected.viewport.height) {
    issues.push(`viewport expected ${expected.viewport.width}x${expected.viewport.height}, got ${snapshot.viewport?.width}x${snapshot.viewport?.height}`);
  }
  if (Math.abs((snapshot.devicePixelRatio ?? 0) - expected.deviceScaleFactor) > 0.01) {
    issues.push(`devicePixelRatio expected ${expected.deviceScaleFactor}, got ${snapshot.devicePixelRatio}`);
  }
  if (Math.abs((snapshot.visualViewportScale ?? 0) - expected.browserZoom) > 0.01) {
    issues.push(`browser zoom expected ${expected.browserZoom}, got ${snapshot.visualViewportScale}`);
  }
  if (snapshot.locale !== expected.locale) {
    issues.push(`locale expected ${expected.locale}, got ${snapshot.locale}`);
  }
  if (snapshot.timezone !== expected.timezoneId) {
    issues.push(`timezone expected ${expected.timezoneId}, got ${snapshot.timezone}`);
  }

  return issues;
}

export async function assertStandardEnvironment(page) {
  const snapshot = await pageEnvironment(page);
  const issues = validateStandardEnvironment(snapshot);
  if (issues.length) {
    const error = new Error(`Non-standard browser environment: ${issues.join("; ")}`);
    error.environment = snapshot;
    error.issues = issues;
    throw error;
  }
  return snapshot;
}

export function writeEnvironmentSnapshot(runDir, snapshot, extra = {}) {
  const payload = {
    standardRuntime: STANDARD_RUNTIME,
    observed: snapshot,
    ...extra
  };
  writeFileSync(join(runDir, "environment.json"), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}
