# wrapit

מעקב ימי עבודה, מחשבוני איגוד, קולשיטים וחשבוניות. זו הגרסה שרצה לבד, בלי Claude.

## איך זה בנוי

| חלק | איפה |
|---|---|
| האפליקציה | `index.html` (קובץ אחד), מתארחת ב-GitHub Pages |
| התחברות | Google, דרך Firebase Auth |
| נתונים | Firestore, תחת `users/<uid>/data`. נשמרים גם במכשיר לעבודה בלי רשת |
| יומן Google ו-Gmail | ישירות מה-API של Google |
| חשבונית ירוקה ו-diff-e-rent | דרך ה-Worker ב-`worker/gate.js`, שמעביר לשרת ה-MCP הקיים |
| מחשבוני איגוד | `calc/*.b64.txt` |
| קריאת PDF של קולשיט | `vendor/pdf*.mjs` |

`adapter.js` מספק לאפליקציה את אותו ממשק שהיה לה בתוך Claude (`window.claude.use(...)`), ולכן הקוד של האפליקציה כמעט לא השתנה. אם הדף נפתח בתוך Claude, הקובץ לא עושה כלום.

ה-Worker מחזיק את ה-refresh token של Google ואת כתובת המחבר של חשבונית ירוקה, כדי שאף סוד לא יגיע לדפדפן או ל-repo.

## הקמה (פעם אחת)

### 1. Firebase
1. ב-[console.firebase.google.com](https://console.firebase.google.com) יוצרים פרויקט חדש.
2. **Authentication → Sign-in method** מפעילים את **Google**.
3. **Authentication → Settings → Authorized domains** מוסיפים את `ofirkarl.github.io`.
4. **Firestore Database → Create database** (אזור `europe-west`). אחר כך **Rules**: מדביקים את התוכן של `firestore.rules` עם כתובת המייל שלך במקום `REPLACE@gmail.com`, ומפרסמים.
5. **Project settings → Your apps → Web (`</>`)**: מעתיקים את ה-`firebaseConfig` לקובץ `config.js`.

### 2. Google Cloud (אותו פרויקט שנוצר ב-Firebase)
1. ב-[console.cloud.google.com](https://console.cloud.google.com) בוחרים את הפרויקט של Firebase.
2. **APIs & Services → Library**: מפעילים את **Google Calendar API** ואת **Gmail API**.
3. **OAuth consent screen**: סוג External. מוסיפים את ה-scopes:
   `calendar.events`, `calendar.readonly`, `gmail.readonly`, `gmail.send`.
   בסוף לוחצים **Publish app**, אחרת Google מנתק את ההרשאה כל 7 ימים. במסך ההתחברות תופיע אזהרה שהאפליקציה לא מאומתת: לוחצים „מתקדם” ואז „המשך”.
4. **Credentials → Create credentials → OAuth client ID** מסוג Web application:
   - Authorized JavaScript origins: `https://ofirkarl.github.io`
   - שומרים את ה-Client ID (נכנס ל-`config.js` ול-`worker/wrangler.toml`) ואת ה-Client secret (נכנס רק ל-Worker, כסוד).

### 3. Cloudflare Worker
מתוך התיקייה `worker`:
```
npx wrangler kv namespace create TOKENS        # מעתיקים את ה-id ל-wrangler.toml
# ממלאים ב-wrangler.toml את GOOGLE_CLIENT_ID ואת FIREBASE_PROJECT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put ALLOWED_EMAILS          # המייל שלך
npx wrangler secret put MCP_URL                 # הכתובת המלאה של מחבר חשבונית ירוקה, כמו ב-claude.ai
npx wrangler deploy
```
את הכתובת שמתקבלת (`https://wrapit-gate.<...>.workers.dev`) מכניסים ל-`gateUrl` ב-`config.js`.

### 4. GitHub Pages
**Settings → Pages → Deploy from a branch**, ענף `main`, תיקייה `/ (root)`. האפליקציה תהיה בכתובת `https://ofirkarl.github.io/Wrait/`.

### 5. העברת הנתונים מ-Claude
1. בגרסה שבתוך Claude: **הגדרות → גיבוי נתונים → ייצוא לקובץ**.
2. בגרסה החדשה, אחרי ההתחברות: **הגדרות → גיבוי נתונים → ייבוא מקובץ**.

קובץ הגיבוי כולל פרטי לקוחות ואנשי קשר, ולכן לא מעלים אותו ל-repo.

## מה שונה מהגרסה ב-Claude
- **קולשיטים:** נקראים ישירות מהמייל. סקריפט ההעתקה ל-Drive כבר לא נחוץ.
- **מחשבון מותאם שהעלית:** נשמר ב-Firestore (`users/<uid>/blobs`) ולא ב-Claude.
- **התנתקות:** הגדרות → גיבוי נתונים → התנתקות.
- **כשההרשאה של Google פגה:** מופיע למעלה כפתור „התחבר מחדש”.

## אבטחה
- **ה-repo ציבורי:** אין בו מפתחות, סיסמאות או נתונים אישיים. הערכים ב-`config.js` ציבוריים מטבעם, וההגנה עליהם היא כללי Firestore וה-Worker.
- **ה-Worker:** מקבל רק Firebase ID token של מייל שמופיע ב-`ALLOWED_EMAILS`, ומעביר רק את כלי חשבונית ירוקה שהאפליקציה משתמשת בהם.
- **Firestore:** כל משתמש ניגש רק לתיקייה שלו, ורק המייל המורשה.
