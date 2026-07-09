<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/0ffb89d7-d9fb-4da4-96a8-e89f52dfad9a

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Cutting a Release

The desktop app auto-updates via `electron-updater`, checking GitHub Releases on
[hasbach/omnipos](https://github.com/hasbach/omnipos). Every installed copy checks for
updates ~10s after launch and prompts the user to install. Publishing a release is a
manual step (there is no CI pipeline for this yet):

1. Bump `"version"` in [package.json](package.json).
2. Create a GitHub [personal access token](https://github.com/settings/tokens) with
   `repo` scope and export it:
   ```
   $env:GH_TOKEN = "ghp_xxxxxxxxxxxx"
   ```
3. Build and publish:
   ```
   npm run build
   npm run build:server
   npx electron-builder --win --publish always
   ```
   This uploads the Windows installer and `latest.yml` to a new GitHub Release tagged
   with the version from step 1.
4. That's it — existing installs will detect the new release and offer to update
   automatically. No further code changes are needed for the update itself to work.

## License Activation

New registrations are inactive until approved. To activate your license (or renew a
subscription), contact:

- **Email:** hsalloum60@gmail.com
- **Phone:** +961 71 315 744
