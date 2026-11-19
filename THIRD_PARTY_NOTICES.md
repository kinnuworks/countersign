# Third-party notices

The agent panel embeds two fonts as base64 in `src/extension/panelFonts.ts` (Latin subsets as published by Fontsource), because the webview's Content-Security-Policy allows no network fonts:

- **Mona Sans**, Copyright (c) 2023, GitHub, https://github.com/github/mona-sans. SIL Open Font License 1.1: [licenses/MonaSans-OFL.txt](licenses/MonaSans-OFL.txt)
- **Monaspace Neon**, Copyright (c) 2023, GitHub, https://github.com/githubnext/monaspace. SIL Open Font License 1.1: [licenses/Monaspace-OFL.txt](licenses/Monaspace-OFL.txt)

npm dependencies keep their own licences (see `package-lock.json`): `@truefoundry/trueforge-sdk` (MIT), `@modelcontextprotocol/sdk` (MIT), `diff` (BSD-3-Clause), `zod` (MIT).
