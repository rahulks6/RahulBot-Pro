# Katkee Privacy Policy

**Draft — not legal advice.** This accurately describes what the current
codebase actually collects and does with data (verified against
`backend/`'s real schema and endpoints, not generic boilerplate), so it's
a genuinely useful starting point. Have an actual lawyer review it before
you publish it — data protection law (GDPR if you have any EU users,
CCPA/CPRA if California, children's privacy law if anyone under 13 could
plausibly sign up) has real requirements a non-lawyer draft can't
guarantee it meets, and both Apple and Google will reject a submission
whose privacy policy doesn't match what the app's declared "nutrition
label" (App Privacy / Data Safety form — see `../STORE_LISTING.md`) says.

**Last updated:** _fill in when you publish this_
**Effective date:** _fill in when you publish this_

This must be published at a real, publicly reachable URL before you can
submit to either store (e.g. `https://yourapp.com/privacy`) — a Markdown
file in this repo isn't enough by itself.

## 1. Who we are

Katkee ("we", "us") operates the Katkee mobile app and the backend
service it talks to. Contact: _fill in a real support email before
publishing — both stores require one, and it's where account-deletion
and data-access requests should go (see Section 7)._

## 2. What we collect

### Account information
Username, email address, a securely hashed password (we never store your
actual password — see Section 5), display name, and an optional bio.

### Content you create
Photos and videos you publish as Stories, captions, comments you post,
messages you send (including when you share a Story into a
conversation), and Highlights you create from your own past Stories.

### Your connections
Who you follow, who follows you, and who you've blocked or muted.

### Activity signals used to rank what you see
We record real engagement signals — which Stories you view and for how
long, likes, comments, shares, profile visits, and an explicit "Not
Interested" signal when you use it — to rank the Home feed and
recommend creators. This is a deterministic scoring formula over your
own real activity, not a third-party ad-targeting profile, and none of
it is sold or shared with advertisers (we don't have any).

### Reports
If you report a Story, comment, or account, we keep a record of who
filed the report, what it was about, and how a moderator resolved it.

### Technical information
Your IP address (used only to enforce rate limits against abuse — see
`backend/README.md`'s Phase 11 section — and briefly in server request
logs) and basic device/app metadata (like your device's user-agent
string) associated with your login sessions, so we can let you revoke a
specific device's access.

### What we do **not** collect
We do not access your contacts, precise or coarse location, or any
device sensors beyond the camera/microphone you explicitly use to
capture a photo or video. We do not run third-party advertising or
analytics SDKs. We do not sell your data to anyone, for any reason.

## 3. How we use it

To operate the core product: create your account, publish and show you
Stories, deliver notifications, run direct messages, rank your Home
feed, and act on reports through our moderation process (see
`backend/README.md`'s Phase 10 section for exactly what that process
does — a human moderator can remove reported content or suspend an
account, and suspension actually revokes that account's active login
sessions).

We do not use your content or activity to train any third-party AI
model, and we do not share it with data brokers.

## 4. Who can see what

- A **public** account's Stories are visible to anyone; a **private**
  account's are visible only to approved followers — this is your
  choice, changeable anytime in your profile.
- Direct messages are visible only to the two participants in that
  conversation.
- Blocking someone hides your content from them and theirs from you, in
  both directions, immediately.

## 5. How we protect it

Passwords are hashed with scrypt (a real, deliberately slow,
industry-standard algorithm) — we never store or can recover your actual
password. Sessions use short-lived signed access tokens plus a
longer-lived, individually revocable refresh token per device.
Connections to our backend are encrypted (HTTPS/TLS). Suspending an
account for a policy violation immediately revokes all of that account's
active sessions, not just future logins.

## 6. How long we keep it

Your content and account data are kept until you delete them or close
your account. A deleted Story is immediately and permanently
inaccessible, including to you. _Fill in your actual backup-retention
window here once you've set one up — e.g. "deleted data may persist in
encrypted backups for up to 30 days before being permanently purged."_

## 7. Your choices and rights

You can edit your profile, change your account from public to private
(or back), unfollow/block/mute anyone, and delete your own Stories and
comments at any time directly in the app. _You'll need to add an
in-app or emailed account-deletion path before launch — both stores now
require one (Apple explicitly requires an in-app path since 2022; Google
requires a clear path and a web form if the app can't provide one
itself). Contact **[support email]** to request a copy of your data or
full account deletion in the meantime._

If you're in the EU/UK, you have rights under GDPR (access, correction,
deletion, portability, objection) — contact us to exercise them. If
you're a California resident, you have similar rights under the
CCPA/CPRA.

## 8. Children

Katkee is not directed at children under 13 (or the minimum age required
by your local law, which may be higher), and we don't knowingly collect
data from them. _If you want under-13 users, that's a materially
different (and much stricter) compliance path — COPPA in the US, similar
regimes elsewhere — and needs its own dedicated review; this policy
assumes you're not doing that._

## 9. Changes to this policy

We'll update the "Last updated" date above and, for material changes,
notify you in the app before they take effect.

## 10. Contact

_[Your support email / company name / mailing address, if you have a
legal entity — required by some jurisdictions.]_
