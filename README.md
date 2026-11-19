# Shelf

A simple tracker for your Kobo ebooks and manga. Categories: **Currently reading**, **In Kobo**, **Library**, **Queue**, **Interested** (a book can be in several. Library is simply every book you have read, any format; Reading, Queue and Interested are one-at-a-time).
Search shows synopsis, author and series/number. Syncs live between laptop and phone.

Total cost: free. Setup takes about 10 minutes, once.

## 1. Put the code on GitHub and turn on Pages
1. Create a new GitHub repository (public is fine) and upload everything in this folder (keep the `docs` folder).
2. Repo **Settings → Pages → Build and deployment**: Source = *Deploy from a branch*, Branch = `main`, folder = `/docs`. Save.
3. After a minute your app is live at `https://YOUR-USERNAME.github.io/YOUR-REPO/`.

## 2. Create the free Firebase backend (this is what syncs your data)
1. Go to https://console.firebase.google.com → **Add project** (turn Analytics off).
2. **Build → Authentication → Get started**. Enable **Google** and **Email/Password**.
   In **Settings → Authorized domains**, add `YOUR-USERNAME.github.io`.
3. **Build → Firestore Database → Create database** (production mode, any region near you).
   Open the **Rules** tab and replace the rules with:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{uid}/{document=**} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
     }
   }
   ```
   then **Publish**.
4. **Project settings (gear) → Your apps → Web (`</>`)** → register an app. Copy the `firebaseConfig` values into `docs/firebase-config.js` and commit.

## 3. Use it
- Open the Pages link on your laptop and phone and sign in with the same account.
- Phone: browser menu → **Add to Home Screen** (Chrome) / **Share → Add to Home Screen** (Safari) to get an app icon.
- Items you add on one device appear on the other within seconds. It also works offline and syncs when you reconnect.

## Notes
- Search uses Google Books (falls back to Open Library) for books and AniList for manga. Series info for books is detected from titles on a best-effort basis, so every field is editable.
  For manga, the series is the manga itself; put the volume you own/are reading in Number.
- Sideloaded file not found in search? Use **Add manually**.
- Menu (three dots) has Copy backup / Restore backup as a safety net.
