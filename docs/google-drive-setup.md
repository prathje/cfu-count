# Google Drive setup

The app talks to Google Drive straight from the browser. There is no application
server, but Google still needs a Cloud project that identifies the app. This guide
creates one and wires it into local development and the GitHub Pages build.

Without this configuration the app still works fully in the browser, with Drive shown
as "not configured".

## What you will end up with

| Value | Env var | Public or secret? |
| --- | --- | --- |
| OAuth 2.0 Web client ID | `VITE_GOOGLE_CLIENT_ID` | **Public.** It ships in the JavaScript bundle. |
| Browser API key (restricted) | `VITE_GOOGLE_API_KEY` | **Public.** It ships in the bundle; protected by referrer and API restrictions. |
| Cloud project number (Picker "app ID") | `VITE_GOOGLE_APP_ID` | **Public.** |
| Scope mode (optional) | `VITE_GOOGLE_DRIVE_SCOPE` | Public. `file` (default), `readonly` or `full`. |

No client secret, service account or private key is used. If a Google console page
offers to download a client secret, you don't need it; never commit one.

## 1. Create the Cloud project

1. Open <https://console.cloud.google.com/> and sign in with the account that will own
   the app (for a lab, use a shared or institutional account, not a personal one).
2. Project picker → **New project**. Name it, e.g. `colony-counter`. Create.
3. Note the **project number** shown on the project dashboard (also under
   **IAM & Admin → Settings**). This is `VITE_GOOGLE_APP_ID`. It's the number, not the
   project ID string.

## 2. Enable the APIs

**APIs & Services → Library**, then enable:

- **Google Drive API**
- **Google Picker API**

## 3. Configure the OAuth consent screen

**Google Auth Platform** (older consoles: **APIs & Services → OAuth consent screen**):

1. **Branding**: app name, user support email, developer contact email. Add the app's
   home page URL (`https://<user>.github.io/<repo>/`) and a privacy policy URL if you
   plan to publish.
2. **Audience**:
   - *Internal*: only for a Google Workspace organisation; only its members can sign
     in and no verification is needed.
   - *External*: anyone with a Google account. Starts in **Testing**.
   - While in **Testing**, add each person under **Test users**. Only they can sign
     in, and Google caps the number of test users (100).
3. **Data access** → **Add or remove scopes** → add
   `https://www.googleapis.com/auth/drive.file` ("See, edit, create and delete only
   the specific Google Drive files you use with this app"). It is a non-sensitive
   scope.
   - Only if you opt into a broader mode (see "Scope choice" below), also add
     `.../auth/drive.readonly` or `.../auth/drive`. Both are **restricted**.
4. **Publishing**: when ready for users outside the test list, **Publish app** (moves
   to "In production"). With only `drive.file`, Google asks for at most light brand
   verification. Restricted scopes require restricted-scope verification first; see
   `docs/research/google-drive.md`.

## 4. Create the OAuth client

**Google Auth Platform → Clients** (or **APIs & Services → Credentials → Create
credentials → OAuth client ID**):

1. Application type: **Web application**. Name: e.g. `colony-counter web`.
2. **Authorised JavaScript origins** (scheme + host + port, no path, no trailing slash):
   - `http://localhost:5173` (Vite dev server)
   - `http://localhost:4173` (optional, `npm run preview`)
   - `https://<user>.github.io` (GitHub Pages; the origin has no `/<repo>` path even
     though the app lives under it)
   - any custom domain you serve the app from
3. **Authorised redirect URIs**: leave empty. The token model uses a popup and needs
   none.
4. Create, then copy the **Client ID** (`…apps.googleusercontent.com`). This is
   `VITE_GOOGLE_CLIENT_ID`. Ignore the client secret.

Origin changes can take a few minutes to apply.

## 5. Create and restrict the API key (for Google Picker)

**APIs & Services → Credentials → Create credentials → API key**, then **Edit API key**:

1. **Application restrictions → Websites**, add:
   - `http://localhost:5173/*`
   - `https://<user>.github.io/*`
   - `https://docs.google.com/*`: required, because the Picker runs in an iframe on
     that domain.
2. **API restrictions → Restrict key** → select **Google Picker API** only.
3. Save, then copy the key. This is `VITE_GOOGLE_API_KEY`.

## 6. Configure local development

Create `.env.local` in the repository root. `*.local` is already in `.gitignore`.

```dotenv
VITE_GOOGLE_CLIENT_ID=1234567890-abc123.apps.googleusercontent.com
VITE_GOOGLE_API_KEY=AIzaSy...
VITE_GOOGLE_APP_ID=1234567890
# Optional: file (default) | readonly | full
# VITE_GOOGLE_DRIVE_SCOPE=file
```

Restart `npm run dev` after editing (Vite reads env files at startup) and open
<http://localhost:5173>. Use `localhost`, not `127.0.0.1`: the origin must match exactly.

If only some of the three variables are set, Drive stays disabled and the browser
console names the missing ones.

## 7. Configure GitHub Pages builds

The values are compiled into the static bundle at build time, so the build job needs
them. They are public identifiers, so store them as repository **variables** (not
secrets; secrets also work, but nothing here is secret):

1. GitHub repo → **Settings → Secrets and variables → Actions → Variables** →
   **New repository variable**, once each for `VITE_GOOGLE_CLIENT_ID`,
   `VITE_GOOGLE_API_KEY`, `VITE_GOOGLE_APP_ID` (and optionally
   `VITE_GOOGLE_DRIVE_SCOPE`).
2. `.github/workflows/deploy.yml` passes them to `npm run build`:

   ```yaml
   - run: npm run build
     env:
       VITE_GOOGLE_CLIENT_ID: ${{ vars.VITE_GOOGLE_CLIENT_ID }}
       VITE_GOOGLE_API_KEY: ${{ vars.VITE_GOOGLE_API_KEY }}
       VITE_GOOGLE_APP_ID: ${{ vars.VITE_GOOGLE_APP_ID }}
       VITE_GOOGLE_DRIVE_SCOPE: ${{ vars.VITE_GOOGLE_DRIVE_SCOPE }}
   ```

3. **Settings → Pages → Source: GitHub Actions**. Push to `main`, then open
   `https://<user>.github.io/<repo>/` and click **Connect Google Drive**.

## Scope choice

| Mode | Requested scopes | Opening an existing folder of photos | Google review |
| --- | --- | --- | --- |
| `file` (default) | `drive.file` | The user picks the folder, then selects the images in it once (multi-select). Files the app saved are reopened without further prompts. | none / light brand verification |
| `readonly` | `drive.file` + `drive.readonly` | All images in the folder and `images/` are found automatically | restricted-scope verification for public use |
| `full` | `drive` | same as `readonly` | restricted-scope verification for public use |

`drive.file` is the least-privilege option and the recommended default. Use `readonly`
for an Internal (Workspace) app or a Testing-mode app with named users, where
verification does not apply. Details and sources: `docs/research/google-drive.md`.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Popup says `Error 400: redirect_uri_mismatch` or `origin_mismatch` | The page origin is missing from **Authorised JavaScript origins** (check the port, http vs https, and localhost vs 127.0.0.1). |
| `Error 403: access_denied` "app has not completed verification" | App is in Testing and the account is not a test user. |
| Sign-in popup does nothing | Popup blocked. Allow popups for the site, click Connect again. |
| Picker shows "The API developer key is invalid" | Key restrictions: add the site and `https://docs.google.com/*`, and allow Google Picker API. |
| Picker opens, but picked files return 404 | `VITE_GOOGLE_APP_ID` is not the project **number** of the project that owns the client ID. |
| "Reconnect required" after about an hour | Access tokens expire (about 1 hour). Click Reconnect; local work is kept. |
