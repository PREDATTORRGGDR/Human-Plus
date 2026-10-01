# NOTES: результати розвідки API HUMAN Школа

Усе нижче перевірено вручну на живій сесії учня (вбудований браузер + `npm run probe`). Персональних даних тут немає:
лише назви полів, коди відповідей і числові перелічення. API недокументоване й може змінитися; про це в README.

## 1. Звідки береться `uid`

- `uid` = `lmsUser.id` із `GET /v1/{uid}/system/info` (id облікового запису в закладі, **не** `globalUser.id`).
- Той самий номер лежить у читабельній (не `httpOnly`) куці `last-sub-client-id` на домені `.human.ua`.
  Застосунок читає її з сесії `persist:human` через `session.cookies.get` (`src/api.js` → `UID_COOKIE`).
- Якщо `lmsUser.id` у відповіді не збігається з кукою, роль не вважається підтвердженою (відмова).
- Жодних хардкод-значень. Нічого, крім імені куки, не зашито.
- Схема входу: `lms.human.ua` → `id.human.ua` (пошта/пароль або Microsoft) → сторінка вибору закладу
  (`id.human.ua/account/profile`, картка закладу з роллю) → `lms.human.ua/auth/?a=…` → `lms.human.ua/app/calendar`.

## 2. Як визначається роль

- `system/info.lmsUser.role_id`. Перелічення взято з коду фронтенду Human: **2 = Учень**, 3 = Викладач, 7 і 100 = Адміністратор.
  (Інше перелічення `BASE:0 … STUDENT:2, TEACHER:3, HEAD_TEACHER:4, ADMIN:5, PARENT:6…` стосується тарифів/запитів Premium
  і для ролі в закладі не використовується; `usersPremiumRequest.role` — не ознака ролі.)
- Батьки: у `system/info` непорожній `parentUser`, а `lmsUser` описує дитину, тому окремо відсікаємо.
- Додаткові запобіжники в `isStudent()`: `role_id` строго число 2, `lmsUser.status === 1`, `lmsUser.id === uid`,
  у `menuSettings` є `student_*` і немає `teacher_*`/`admin*`/`parent*`/`head*`.
- Усе інше (порожня відповідь, невідома роль, рядок замість числа, 4xx/5xx) → екран «Додаток доступний лише для учнів»
  або помилка, але не дані. Перевірка виконується при кожному оновленні **до** запиту календаря.
- Не перевірено на реальному акаунті вчителя (його немає): відмова спирається на перелічення з коду фронтенду та юніт-тести `isStudent`.

## 3. Куки / CORS в Electron

- `session.fromPartition('persist:human').fetch(url, { credentials: 'include' })` з main-процесу **підхоплює куки**:
  `system/info` і `calendar` повернули 200 (`scripts/probe.js`). Куки сесії `authToken`, `PHPSESSID`, `_csrf` — `httpOnly`, `SameSite` не задано.
  Запасний варіант (прихований BrowserView + `executeJavaScript`) **не потрібен і не реалізований**.
- `credentials: 'omit'` → `401` (авторизація справді лише через куки).
- Запити — лише `GET`, тому `_csrf` не потрібен.
- **Пастка:** сторінка `id.human.ua` шифрує `navigator.userAgent` через `btoa()`. Electron за замовчуванням додає в UA ім'я
  застосунку; кирилиця («Human Дашборд») ламає `btoa`, і кнопки на сторінці вибору закладу мовчки перестають працювати.
  Тому для вікон ставимо латинський UA (`app.userAgentFallback`), а для запитів до API додаємо прозорий `HumanPlus/<версія> (unofficial; read-only; …)`.
- Сторінка входу не працює без скриптів Firebase (`www.gstatic.com/firebasejs/`). Їх єдиних і пропускаємо серед сторонніх хостів; Sentry,
  Google Tag Manager, реклама, Cloudflare Insights, платіжний віджет та шрифти блокуються (`webRequest`).

## 4. Ознака протухлої сесії

- Без дійсних кук API відповідає `401` з тілом `{"name":"Unauthorized","message":"Your request was made with invalid credentials.","code":0,"status":401}`.
- Невідомий `uid` → `422` `[{"field":"lms_id","message":"LMS account not found"}]`: трактуємо як «потрібен вхід».
- Обидва випадки → екран «Сесія закінчилась, увійдіть знову»; кеш у `userData` лишається.
- Заголовків `Retry-After`, `ETag`, `Last-Modified`, `X-RateLimit-*` у відповідях немає; `Cache-Control: no-store`. Умовні запити неможливі.

## 5. Статуси ДЗ

**Джерело істини — `GET /v1/{uid}/home-task/home-task/students-tasks?expand=group.subject,home_tasks_user.assessment&filter=<категорія>`**
(саме його використовує оригінальна вкладка «Завдання»). Категорії: `received` (видані), `review` (на перевірці), `approved` (прийняті),
`rejected` (повернуті); є ще `overdue`, `receivedToday/Tomorrow/Week/WithoutExpireDate` (піднабори, нам не потрібні). Один запит на категорію
(`x-pagination-page-count: 1` із `_limit=987654321`). Лічильники збігаються з `students-tasks-count` (перевірено: 87 / 9 / 83 / 0).

| Категорія | Підпис у Human | Наш статус |
|---|---|---|
| `received` | Видане / Отримано | `assigned` «Видане» |
| `review` | Відправлено на перевірку | `submitted` «На перевірці» |
| `approved` | Прийнято | `accepted` «Прийнято» |
| `rejected` | Повернуто | `returned` «Повернуто» |

- «Прострочено» (`overdue`) рахуємо самі: категорія `received` або `rejected` і `expire_date` < зараз. Серверний фільтр `overdue` ми не використовуємо:
  він рахує інакше (включно із завданнями без дедлайну тощо), а нам потрібна відповідність вкладкам «Видані»/«Прийняті».
- **Пастка:** число `home_tasks_user.status` ненадійне для класифікації: у категорії `approved` трапляється `status: 0` (прийнято вчителем без здачі),
  а `plan/theme/{id}` у `home_tasks[].home_tasks_users[0].status` завжди `0` і статусу ученика **не відображає**. Тому статус беремо з категорії списку, а не з числа.
- Календар (`userHomeTasks[].homeTasksUsers[].status`: 0 видане, 1 відправлено, 2 прийнято, 3 повернуто, з шаблону календаря Human) лишається запасним шляхом,
  якщо `students-tasks` недоступний: тоді статуси наближені, а секція `studentTasks` потрапляє у «нерозпізнані».
- Денний лічильник «3/6» в UI календаря = завдання з дедлайном цього дня; виконані = статус ≠ 0 (звірено).
- «Здано з запізненням»: `date_submission > expire_date` (поле `late`).
- Елемент списку: `id`, `expire_date` (може бути `null`), `theme{id,title}`, `group.subject`, `home_tasks_user{status,date_submission,assessment}`,
  `published_at`; немає `content_id` і `updated_at` (беремо з календаря, інакше `published_at`).

## 6. Оцінки

- Лежать у `calendar.assessments[]` (окремий ендпоінт не потрібен, дорожче нічого не стає): `int_value` (число або `null`),
  `entity_type` (1 = завдання, 2 = заняття/робота), `home_task_id`, `lesson_task_id`, `created_at`, вкладена `group.subject`.
  Вид роботи («Заняття», «Зошит», «Тест»…) беремо з `lessonTasks[].type.name`.
- Вкладка «Оцінки» входить у v1; показує оцінки за завантажений період, середніх не рахуємо.

## Інші знахідки, що вплинули на дизайн

- **Широкий діапазон одним запитом.** `calendar?dateStart&dateFinish` приймає і 29, і 60 днів (≈0,5 МБ, ≈2,4 с). Оригінал у денному
  вигляді просить один день (≈150 КБ, 7 запитів на відкриття сторінки). Ми беремо вікно «понеділок тижня −2 тижні … +5 тижнів» **одним** запитом.
- **`lessonEvents` існують лише для створених уроків.** Майбутні дні майже порожні. Повний розклад — з `scheduleHelpers`
  (`day_of_week` 1–7 як ISO, `period` → `periods[].number`, `week`: 0 = чисельник, 1 = знаменник, 2 = щотижня; чисельник/знаменник
  за `isoWeek % 2`: непарний → знаменник) у межах `scheduleHelperContainers[].date_start/date_finish`. Час уроку: `periods[].start_at/finish_at` (секунди від півночі, `group_number` 99).
- **ДЗ до уроку:** `lessonEvent.theme_id === homeTask.theme_id`. Вкладка «Сьогодні» показує саме ДЗ, задане на уроках дня.
- **Текст ДЗ** — `plan/theme/{theme_id}?expand=home_tasks.content,…`: `home_tasks[].content.blocks[]`, тип `tx01` → `data.text` (HTML).
  Інших типів блоків у наших даних не було; їх показуємо як «Відкрити в Human». У календарі `description` порожнє.
  Ключ інвалідації кешу тексту — `homeTask.updated_at` із календаря (`content.hash` є, але `updated_at` приходить безкоштовно).
- **Межі дня:** `dateStart` = північ `Europe/Kyiv`; «день = +86400 с» хибне в дні переходу часу (23 або 25 годин), тож межі рахуємо календарно.
- **Не перевірено на живих даних** (у тестовому акаунті порожні): `cancellationLessons`, `lessonReschedules`, `replacementTeachers`, `weekends`.
  Поля взято з коду фронтенду (`cancellationLessons[].date/schedule_helper_id/id`, `replacementTeachers[].lesson_event_id`); `lessonReschedules` і `weekends`
  лише позначаємо захисно. Нормалізатор не падає на іншій формі, а секція потрапляє у «Нерозпізнані секції».

## Вміст завдань і занять (блоки)

- `plan/theme/{theme_id}?expand=home_tasks.content,home_tasks.type,lesson_tasks.content,lesson_tasks.type` віддає **і ДЗ, і матеріали уроку** (`lesson_tasks`:
  «Заняття», «Зошит», «Тест»…) одним запитом. Вміст — `content.blocks[]`.
- Реєстр блоків редактора Human (з коду фронтенду): `tl01` заголовок (`data.title`), `tx01` текст-HTML (`data.text`, застарілий), `tx02` назва й опис,
  `tx03` текст нового покоління (`data.linesEditor`, форму не підтверджено), `ip01` «До уваги» (`data.text`), `im01` зображення (`data.url` — повна адреса на
  `files.human.ua/images/…`, `data.text` — підпис), `fl01` файл (`data.file{name,extension,size,hash}`), `lk01` посилання (`data.link{url,title,description,image}`),
  `cf01` формула TeX, `ct01` таблиця, `dv01` лінія, `qn01` питання, `pl01` опитування. У живих даних зустрілися лише `tx01` і `lk01`; решта реалізована за реєстром.
- Файли: `https://files.human.ua/{uid}/file/get/{hash}` (база з `IMAGE_STORAGE_BASE_HREF`, `uid` = `lmsId`). Зображення: повна адреса з `im01.data.url`.
- Превʼю посилання (`link.image`) — це сторонні домени (наприклад YouTube): не завантажуємо, показуємо назву, опис і домен.
- Матеріали уроку зіставляються з уроком за `lessonTasks[].theme_id === lessonEvent.theme_id`.
- Тип `tx03` і блоки, яких ми не розпізнали, показуються як «цей фрагмент поки не вміємо показувати»; імена нерозпізнаних типів можна побачити в діагностиці.
