# Which Seed Are You? (Cloudflare version)

The full quiz, with the email step: people see their seed card, then enter an email to unlock the full breakdown.
Each email is sent to MailerLite by `functions/api/subscribe.js`. The API key stays in Cloudflare.

## Deploy (the same steps as the trial)
1. GitHub: create a new repository and upload everything in this folder (`index.html`, `assets/`, `functions/`), keeping the folder structure.
2. Cloudflare: go to Workers & Pages → Create → Pages → Connect to Git and pick the repository. Use framework preset None and leave the build command and output directory empty.
3. When MailerLite is ready: go to Settings → Variables and Secrets and add a **Secret** named `MAILERLITE_API_KEY`, then redeploy.

Until the key is added, the quiz works normally. People can still unlock their results, but their emails aren't saved.

## MailerLite groups (created automatically on the first sign-up)
- **Quiz – results only**: everyone
- **Quiz – Kang Kong**, **Quiz – Chilli**, **Quiz – Papaya**: by seed
- **Skillseed newsletter**: only if they ticked the box (set `ML_GROUP_NEWSLETTER` to use an existing group)

Fields: `quiz_seed` and `quiz_consent`.

## Results emails
The quiz tells people "We'll also email you your results". Set up one MailerLite automation per seed group: when a subscriber joins "Quiz – Chilli", send the Chilli results email, and so on.

## Testing tip
Once someone unlocks their results, that browser remembers it. To see the email step again, use a private/incognito window.
