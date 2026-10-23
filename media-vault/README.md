# MediaVault — encrypted private media library

A mobile-first static site for four or fewer invited users. Media never goes through GitHub Pages or a paid backend: each device fetches encrypted 4 MiB chunks from a private Google Drive folder, decrypts in memory and plays locally.

**Current state:** Complete source and UI are committed under \`media-vault/\`. The Google OAuth Web Client ID is **not yet configured**, so sign-in cannot work until the owner performs Google Cloud Console setup below. Live Google Drive playback has not yet been tested. Do not claim a completed production deployment before that setup and device tests.

## Features

- Google sign-in; admin role is determined by SHA-256 of the verified owner's Google email. Actual write permission is always enforced by Google Drive (frontend role check is not a security boundary).
- Admin creates the encrypted catalog, encrypts uploads in the browser and invites viewers by granting **reader** permission to the Drive folder.
- Catalog and names are encrypted with AES-256-GCM using a key derived via PBKDF2-SHA256 (310,000 iterations) from the shared passphrase.
- Every independently authenticated 4 MiB ciphertext chunk gets a fresh 96-bit IV and includes media ID + chunk index as authenticated additional data.
- A Service Worker decrypts HTTP byte ranges for HTML5 video/audio without a VPS. Its CacheStorage holds **encrypted** chunks (up to ~640 MiB) and never stores the passphrase or tokens persistently.
- Manga: CBZ/ZIP of images; books: PDF, EPUB and TXT; images: JPEG/PNG/WebP/etc.; music: MP3/M4A/OGG; videos: MP4/WebM, depending on browser codecs.
- No third-party analytics or advertising.

## Required one-time setup (owner)

1. Open [Google Cloud Console](https://console.cloud.google.com/) in the **intended owner Google account**, create/select a Google Cloud project and enable **Google Drive API**.
2. Under **Google Auth Platform**, configure the OAuth consent screen. Select **External / Testing** for a small personal group, and add the owner plus the 3–4 friends as test users. Request the scopes needed for the web app: \`openid\`, \`email\`, \`profile\`, \`https://www.googleapis.com/auth/drive\` for the administrator, and \`https://www.googleapis.com/auth/drive.readonly\` for readers. Google may classify these as sensitive/restricted and require verification for broader public distribution.
3. Under **Clients**, create an **OAuth 2.0 Client ID → Web application**. In Authorized JavaScript origins add the real origin hosting the site (typically \`https://onikri.github.io\`, **without a path**). For local testing add \`http://localhost:8080\`. Popup token flow does not need a client secret.
4. Edit **\`media-vault/config.js\`** and replace the \`googleClientId\` placeholder with the public Web Client ID. NEVER paste a client secret, Drive token or library password into GitHub.
5. Open GitHub repository **Settings → Pages** and make sure Pages deploys from the \`main\` branch and \`/(root)\` (or an equivalent configured deployment). This repository was already in use; the media site only adds the isolated \`media-vault/\` directory. The expected project-pages URL, **if Pages is enabled**, is \`https://onikri.github.io/hots_tank.github.io/media-vault/\`. Confirm the actual published URL before using it; only the GitHub repository is confirmed as written.
6. Visit the live site: **Войти через Google** → **Подключить Drive** → enter a new strong shared phrase twice → **Создать новую библиотеку**. The encrypted index is created in the dedicated Drive folder, and its file ID is saved only in this browser's localStorage. Save the phrase offline; forgetting it makes the media unrecoverable.
7. In admin controls, upload files and then invite reader emails (Drive folder's \`reader\` ACL). Copy the URL with \`?library=...\` and send the passphrase through a separate channel. The reader logs into their own invited Google account, connects Drive as read-only and unlocks the catalog.

### Files already created

- GitHub repository: \`Onikri/hots_tank.github.io\`, folder \`media-vault/\`
- Precreated Google Drive folder: ID \`18qA7Kz_yxnI3Tlcs2Y5Z4tHtEQM4uryr\` (private). If that folder is not accessible to the owner account used in the browser, the site creates a new folder in their own Drive upon initial setup.
- There is no catalog file or encrypted media in Drive **yet**; the owner must choose a secret phrase to initialize it. Never generate or retain that phrase on the owner's behalf.

## Compatibility and limits

- The site's JavaScript is publicly readable. Privacy comes from Google Drive's server-side file permissions **plus encryption**, not hiding code or a public folder ID.
- The owner uses broad Google Drive OAuth scope for uploads and sharing, and readers use \`drive.readonly\`. These scopes grant Google consent to the app for corresponding Drive access. Review the source before authorization.
- Access tokens and CryptoKeys are stored only in page and Service Worker memory. Reauthorize after the token expires or when the SW restarts; playback can stop until the user reconnects.
- Service Worker HTTP Range video playback is experimental and needs real Android/iOS testing; browser-specific Range behavior can differ. Video/audio have an explicit full-file fallback which may be too large for the phone's RAM.
- MP4 with H.264/AAC is the recommended video format. MKV/MOV and some FLAC files may upload but not play natively. Automatic transcoding is not provided.
- Manga and book viewers download the entire CBZ/EPUB/PDF file into phone RAM before opening. Large archives can exhaust memory. For video/audio the Range handler normally downloads only relevant chunks.
- Incomplete uploads can leave orphaned \`asset-...\` folders; delete those manually if needed.
- The 4 MiB chunks are individual Drive files, producing many Drive requests. Service Worker retains up to 160 **encrypted** chunks in CacheStorage and may be evicted by browser storage policies.
- Google Drive's free personal storage allowance is commonly 15 GB shared with Gmail and Photos; downloading/view quotas, API limits, terms and any policies restricting CDN-like use still apply. **1 TB per month is not guaranteed** just because files are encrypted.
- The app currently depends on third-party CDN scripts for JSZip and epub.js. Those scripts execute with the site's privileges. For sensitive material, self-host audited pinned versions and deploy a strict Content Security Policy before treating this as a high-assurance encrypted vault.
- The public URL may not be active until GitHub Pages is enabled and deployed. Google OAuth Client ID and sharing require explicit action by the Google account owner.

## Testing after OAuth configuration

- First encrypt/upload a small PNG, MP3, MP4, PDF, EPUB, TXT and CBZ.
- Confirm they appear in the library and correctly open after refreshing and unlocking.
- Share only with a test viewer and confirm: can view, cannot upload, cannot access Drive without folder permission, and cannot unlock with a wrong phrase.
- On phone, test seeking forward/back in MP4 and playback after switching Wi-Fi to mobile data. The app offers an explicit full-download fallback if SW Range playback fails.

## Threat model

AES-GCM protects encrypted Drive content from storage-side inspection when the passphrase remains secret. It does **not** protect against a malicious site update, compromised Google/GitHub account, compromised browser/device, or third-party JavaScript, and it doesn't erase Drive traffic and account-level metadata. Drive ACLs are the authorization boundary. Share the passphrase only with trusted viewers; everyone with the phrase and file access can decrypt the shared library.
