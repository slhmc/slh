# Loading and action consistency

The loading audit reuses `SpinnerGap` from the existing create-instance install
button and `Button`/`BusyIndicator` from shared controls. Busy buttons replace their
`icon` rather than adding a second icon; text and accessible names remain stable.
The existing reduced-motion rule remains in effect.

Horizon uses the same enabled loader-card composition as Java and Bedrock while
the manifest loads. Installation still requires a Minecraft version and a compatible
release. Loader request errors have an explicit retry action. Manifest completion
preserves a custom instance name. Java controls and validation apply only to Java;
Horizon reports automatic native memory management in the review.

Empty version searches show a neutral result message; Bedrock offers the Store
only when the source catalog itself is empty. No new surfaces or visual tokens.

The instance header launch and stop actions share the standard control height and
a stable minimum width, retaining their existing action colors. Their geometry is
compared to the adjacent Folder action in Russian at 800×560 and 1440×900.

Regression coverage: `Controls.test.tsx`, `loading-consistency.pw.ts`,
`horizon.pw.ts`, `instance-header-regression.pw.ts`. Browser preview covers
loading, failure/retry, empty search, keyboard activation and both viewport sizes.
Native installation of Minecraft and real provider outages are not simulated by
these browser fixtures; this is a focused state-consistency audit, not a complete
audit of every launcher screen.

Validation on 14 November 2026: UI audit and frontend build passed; 200 frontend
tests, 237 core tests (6 live-provider tests ignored), and 11 shell tests passed.
The browser regressions include reduced motion and icon-only refresh dimensions.
The complete build wrapper requires Go, which is unavailable in this environment.
The existing Bedrock helper matches the installed helper by SHA-256; the launcher
is built with `npx tauri build --no-bundle` using that unchanged helper.
