# Order Photo Manager PWA

A mobile-first Next.js PWA for searching Google Sheet orders by the `Personalization` column, uploading order photos to Google Drive, and writing the generated image link back to the same Sheet row in the `Photo Link` column.

## Features

- Password-protected app shell using `APP_PASSWORD`
- Debounced search against the `Personalization` column
- Dynamic header lookup from row 1, with no hardcoded column numbers
- Results sorted so undelivered/non-dispatched rows appear first
- Camera-friendly `Add Photo` flow with browser JPEG compression
- Google Drive upload with anyone-with-link view permission
- Google Sheets update to the matching row
- In-memory Sheet cache for fast repeated searches
- Installable PWA with manifest and service worker

## Required Sheet Columns

Row 1 of the configured tab must include these exact headers:

- `Photo Link`
- `Carrier / Status`
- `Personalization`

You can add more columns anywhere. The app finds required columns by header name.

## Environment Variables

Copy `.env.example` to `.env.local` for local development:

```bash
GOOGLE_SHEET_ID=https://docs.google.com/spreadsheets/d/your-sheet-id/edit
GOOGLE_SHEET_TAB_NAME=Orders
GOOGLE_DRIVE_FOLDER_ID=https://drive.google.com/drive/folders/your-folder-id
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY\n-----END PRIVATE KEY-----\n"
APP_PASSWORD=change-this-password
```

`GOOGLE_SHEET_ID` and `GOOGLE_DRIVE_FOLDER_ID` can be either raw IDs or full Google links.

## Google Cloud Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project or select an existing project.
3. Open **APIs & Services > Library**.
4. Enable **Google Sheets API**.
5. Enable **Google Drive API**.
6. Open **IAM & Admin > Service Accounts**.
7. Create a service account.
8. Open the service account, go to **Keys**, and create a JSON key.
9. From the JSON file, copy:
   - `client_email` into `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` into `GOOGLE_PRIVATE_KEY`

Keep the private key on one line in Vercel or `.env.local` with escaped newlines. The app converts `\n` into real newline characters automatically.

## Share Google Resources

Share the Google Sheet with the service account email using editor access.

Share the target Google Drive folder with the service account email using editor access. Uploaded images are created in this folder and then made viewable by anyone with the link.

## Run Locally

Install dependencies:

```bash
npm install
```

Start the dev server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), enter `APP_PASSWORD`, and search by personalization text.

## Deploy to Vercel

1. Push this project to GitHub, GitLab, or Bitbucket.
2. Import it in [Vercel](https://vercel.com/new).
3. Add all environment variables from `.env.example` in **Project Settings > Environment Variables**.
4. Deploy.

For `GOOGLE_PRIVATE_KEY`, paste the private key exactly as a single environment value. If Vercel stores it with escaped newline characters, this app handles that.

## Install on Mobile

After deployment, open the Vercel URL on your phone.

On iPhone:

1. Open the site in Safari.
2. Tap **Share**.
3. Tap **Add to Home Screen**.

On Android:

1. Open the site in Chrome.
2. Tap the browser menu.
3. Tap **Install app** or **Add to Home screen**.

## API Routes

### `POST /api/login`

Body:

```json
{
  "password": "your-app-password"
}
```

Returns a browser-stored session token after comparing against `APP_PASSWORD`.

### `GET /api/search?q=...`

Requires the `x-app-token` header.

Returns:

```json
{
  "rows": [
    {
      "rowNumber": 2,
      "photoLink": "",
      "status": "In transit",
      "personalization": "Custom order text",
      "priority": 1
    }
  ]
}
```

### `POST /api/upload-photo`

Requires the `x-app-token` header.

Body:

```json
{
  "rowNumber": 2,
  "fileName": "photo.jpg",
  "mimeType": "image/jpeg",
  "base64Image": "..."
}
```

Returns:

```json
{
  "success": true,
  "imageUrl": "https://drive.google.com/uc?export=view&id=...",
  "rowNumber": 2
}
```

## Notes

- This app does not use Google Apps Script, AppSheet, or a database.
- Google credentials are only used in backend API routes.
- Search reads are cached in memory for about 45 seconds.
- Cache is cleared after a successful photo upload.
- Search returns up to 100 results.
