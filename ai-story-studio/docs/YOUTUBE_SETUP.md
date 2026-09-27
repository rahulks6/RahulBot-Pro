# YouTube setup

AI Story Studio uploads to **your** YouTube channel through the official YouTube Data API v3, using
**your own** Google Cloud OAuth client. Nothing goes through a third-party server, and your Google
password is never typed into AI Story Studio: you sign in on Google's own page.

This takes about 15 minutes, once. With a series in English **and** Hinglish you connect **two
channels** (step 5b) with the same OAuth client.

> Status: the app's side of this (sign-in with PKCE, encrypted tokens, resumable upload, captions,
> thumbnail, scheduling, status mapping) is tested against a local stand-in for Google. A real upload
> to a real channel is **NOT TESTED** by the developers. Use the **SAFE PRIVATE TEST UPLOAD** (step 6)
> as your first real check. The two-channel routing (English version → English channel, Hinglish
> version → Hinglish channel) is likewise tested only against the stand-in.

## 1. Create a Google Cloud project

1. Open <https://console.cloud.google.com/> and sign in with the Google account that owns the channel.
2. Top bar → project picker → **New project** → name it e.g. `AI Story Studio` → **Create**.

## 2. Turn on the YouTube Data API v3

**APIs & Services → Library** → search **YouTube Data API v3** → **Enable**.

## 3. Configure the OAuth consent screen

In **APIs & Services → OAuth consent screen** (in newer consoles this is **Google Auth Platform**, with
the tabs Branding, Audience and Data access):

1. **User type / Audience: External.**
2. **App name**: `AI Story Studio` (anything you like), **support email**: yours, **developer contact**:
   yours. Save.
3. **Scopes / Data access** → _Add or remove scopes_ → add:
   - `https://www.googleapis.com/auth/youtube.upload` (upload videos)
   - `https://www.googleapis.com/auth/youtube.force-ssl` (captions, thumbnails, reading the upload's
     status, deleting the private test)
4. **Test users / Audience → Test users** → **Add users** → add the Google account that owns the channel
   (and, if the Hinglish channel belongs to a different Google account, that account too).

While the app is in **Testing**, Google shows an "unverified app" warning on the sign-in page (that is
your own app: choose _Continue_), and Google may expire the connection after **7 days**. When it
expires, the Publish page says so: press **CONNECT YOUTUBE** again. To stop the weekly reconnect you
can set the publishing status to **In production**; for a personal app with a single user you do not
need Google's verification, you only keep seeing the "unverified app" warning when you connect.

## 4. Create the OAuth client (type "Desktop app")

**APIs & Services → Credentials → Create credentials → OAuth client ID**:

- **Application type: Desktop app** (not "Web application").
- Name: `AI Story Studio`.
- **Create**, then copy the **Client ID** (ends in `.apps.googleusercontent.com`) and the
  **Client secret**.

A Desktop-app client lets Google send you back to AI Story Studio on this computer
(`http://127.0.0.1:<port>/publish/youtube/callback`); no redirect URI needs to be entered.

## 5. Connect in AI Story Studio

1. Open AI Story Studio at **`http://127.0.0.1:<port>`** (the address the app printed at start — not
   the computer's network address).
2. **PUBLISH → YouTube connection and schedule** → paste the client ID and client secret → **Save client**.
   They are stored encrypted on this computer (Windows DPAPI), are never shown again and are never logged.
3. Press **CONNECT YOUTUBE** → Google's page opens → choose the channel's account → allow **both**
   permissions. You come back to AI Story Studio: **YOUTUBE CONNECTED ✓ — <your channel>**.

AI Story Studio asks for offline access, so it can upload later without asking again. You can remove
the permission at any time: **DISCONNECT YOUTUBE** in the app (this also revokes it at Google), or
<https://myaccount.google.com/permissions>.

## 5b. The second channel (Hinglish)

**PUBLISH → YouTube connection and schedule** shows one card per **channel profile**: _English
channel_ and _Hinglish channel (India)_. The English card is the connection from step 5. On the
Hinglish card press **CONNECT HINGLISH CHANNEL (INDIA)** and choose the **other** channel's account
(for a YouTube brand channel, pick that channel in Google's account chooser).

- Each profile has its **own** sign-in (stored encrypted under its own name); disconnecting one does
  not touch the other.
- If both profiles are signed in to the **same** YouTube channel, the page says so in red: sign one
  out and connect the right channel, or both languages would go to one channel.
- Each profile has its own **default visibility, schedule (daily / weekly, time, day), audience
  pre-fill** and **time zone of its audience**. For the Hinglish channel choose _India (IST, UTC+5:30)_:
  "18:00" then means 18:00 in India, whatever this computer's clock says. The English channel uses the
  computer's time.
- The profile name can be changed; the language cannot.

## 6. Safe private test upload

On the same page press **RUN PRIVATE TEST UPLOAD** (on each channel's card). The app makes a
3-second test picture, uploads it as **PRIVATE** (never public) to that channel, and reads back its
status. Then press **Delete the test video**.

This proves the connection, the upload and the status reading. It does not publish anything.

## 7. Publishing a video

Nothing is uploaded automatically. When a video is finished it appears under **PUBLISH → Ready for
Review**, with the episode and each Short as separate items. For each one:

- check and edit the **title**, **description** and **tags** (drafted from the story);
- choose the **audience** — _made for kids_ or _not made for kids_. YouTube requires this for every
  video, and AI Story Studio never chooses it for you (the Publish settings can pre-fill it, but you
  still see and confirm it). If your videos are for children, read YouTube's guidance on
  "made for kids" first;
- keep **"contains AI-generated (synthetic) content"** ticked: the videos are AI-made, and YouTube asks
  creators to disclose realistic synthetic content;
- choose the **visibility** (private by default) and press **APPROVE & UPLOAD**, or set a date and time
  and press **APPROVE & SCHEDULE** (uploaded privately now, published by YouTube at that time; at least
  15 minutes ahead).

**Language versions.** A series episode with a Hinglish version has **two** review items per video
(and per Short): English → English channel, Hinglish → Hinglish channel. Each has its own title,
description, tags, captions (`hi-Latn` for Hinglish), thumbnail and suggested time from its own
channel's schedule. You can approve them one at a time, or use **Approve both languages** at the top:

- **APPROVE BOTH & SCHEDULE** uploads both privately now, each with its own channel's next slot (or
  the time you set on the item);
- **APPROVE BOTH & UPLOAD** uploads both now with the visibility shown on each item;
- the audience can be chosen once for all of them;
- it is **all or nothing**: if one item is not ready (audience not chosen, channel not connected, no
  publish time), nothing is approved.

An item that was already approved can never be approved again, so nothing is uploaded twice. A
Hinglish version with flagged lines shows a warning on its item; watch it before approving.

Uploads run one at a time in the background, in 8 MB pieces. If the connection drops or the app closes,
the item shows **UPLOAD FAILED** with **RETRY**, which continues from the last piece YouTube confirmed.
Captions (SRT) and the chosen thumbnail are added after the video.

## What the statuses mean

| Status                     | Meaning                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| READY FOR REVIEW           | Waiting for you. Nothing has been sent.                                                                                             |
| UPLOADING                  | Sending the file.                                                                                                                   |
| PRIVATE                    | Uploaded and private (as you chose).                                                                                                |
| UPLOAD SUCCESSFUL          | Uploaded as unlisted.                                                                                                               |
| SCHEDULED                  | Uploaded privately; YouTube publishes it at the chosen time.                                                                        |
| PUBLISHED                  | Public on YouTube.                                                                                                                  |
| BLOCKED BY API RESTRICTION | YouTube accepted the upload but kept it private, refused it, or the daily quota / upload limit was reached. The message says which. |
| UPLOAD FAILED              | Something went wrong (e.g. connection). **RETRY** continues the upload.                                                             |

## Limits you should know about

- **API audit (important).** Google keeps videos uploaded through API projects that have not passed a
  YouTube API compliance audit **private**. If you ask for _public_ or _unlisted_ (or schedule a video)
  and YouTube keeps it private, AI Story Studio shows **BLOCKED BY API RESTRICTION**. Either change the
  visibility yourself in YouTube Studio, or request an audit with Google's _YouTube API Services — Audit
  and Quota Extension_ form (linked from the YouTube Data API documentation).
- **Daily quota.** A new project gets a default daily quota (10,000 units). A video upload is one of the
  most expensive calls, so only a handful of uploads fit in a day; check Google's quota calculator for
  current costs. When the quota is used up the item shows the reason; try again the next day.
- **Custom thumbnails** need a **verified channel** (<https://www.youtube.com/verify>). Without it the
  video is uploaded and the item says the thumbnail was not set.
- **Your channel, your responsibility.** You are the publisher: check the content, the audience setting
  and YouTube's policies before approving.

## Troubleshooting

| What you see                                                               | What to do                                                                                                     |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| "Open AI Story Studio at http://127.0.0.1:&lt;port&gt; to connect YouTube" | Use the 127.0.0.1 address, not a network address or a different host name.                                     |
| "Access blocked: … has not completed the Google verification process"      | Add your account under **Test users** (step 3).                                                                |
| "Some YouTube permissions were not granted"                                | Connect again and tick both permissions.                                                                       |
| "YouTube no longer accepts this connection"                                | The permission expired or was removed: press **CONNECT YOUTUBE** again.                                        |
| "redirect_uri_mismatch"                                                    | The OAuth client is not of type **Desktop app**: create a Desktop-app client and **Replace the OAuth client**. |
| "This Google account has no YouTube channel yet"                           | Create the channel on youtube.com, then connect again.                                                         |
| "… signed in to the SAME YouTube channel"                                  | Disconnect one profile and connect it again, choosing the other channel/account in Google's chooser.           |
| "Connect the Hinglish channel … first"                                     | The Hinglish version goes to its own channel: connect it (step 5b).                                            |
