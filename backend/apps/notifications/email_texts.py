"""Служебные строки писем (ADR-111): кнопка «Открыть личный кабинет» и
приписка «уведомления можно отключить в кабинете» (просьба пользователя,
2026-08-23) на 29 языках стартовых поверхностей (ADR-089).

Это НЕ l10n-паки: тексты принадлежат транспортной обвязке письма (провайдеру),
а не домену уведомления — subject/body по-прежнему приходят из паков через
render_subject/render_body. Фолбэк — en (та же политика, что fallbackLng
фронта)."""

from __future__ import annotations

OPEN_CABINET: dict[str, str] = {
    "ru": "Открыть личный кабинет",
    "en": "Open your account",
    "ar": "فتح الحساب الشخصي",
    "az": "Şəxsi kabineti aç",
    "bn": "অ্যাকাউন্ট খুলুন",
    "de": "Konto öffnen",
    "es": "Abrir la cuenta",
    "fa": "باز کردن حساب کاربری",
    "fr": "Ouvrir le compte",
    "he": "פתיחת החשבון",
    "hi": "खाता खोलें",
    "hy": "Բացել անձնական էջը",
    "id": "Buka akun",
    "it": "Apri l'account",
    "ja": "アカウントを開く",
    "ka": "ანგარიშის გახსნა",
    "kk": "Жеке кабинетті ашу",
    "ko": "계정 열기",
    "pl": "Otwórz konto",
    "pt-BR": "Abrir a conta",
    "ro": "Deschide contul",
    "sw": "Fungua akaunti",
    "th": "เปิดบัญชี",
    "tr": "Hesabı aç",
    "uk": "Відкрити особистий кабінет",
    "ur": "اکاؤنٹ کھولیں",
    "uz": "Shaxsiy kabinetni ochish",
    "vi": "Mở tài khoản",
    "zh-Hans": "打开账户",
}

UNSUBSCRIBE_HINT: dict[str, str] = {
    "ru": "Уведомления можно отключить в настройках личного кабинета.",
    "en": "You can turn notifications off in your account settings.",
    "ar": "يمكنك إيقاف الإشعارات من إعدادات حسابك.",
    "az": "Bildirişləri hesab parametrlərində söndürmək olar.",
    "bn": "অ্যাকাউন্ট সেটিংসে বিজ্ঞপ্তি বন্ধ করা যায়।",
    "de": "Benachrichtigungen können in den Kontoeinstellungen deaktiviert werden.",
    "es": "Puedes desactivar las notificaciones en la configuración de tu cuenta.",
    "fa": "می‌توانید اعلان‌ها را در تنظیمات حساب خود خاموش کنید.",
    "fr": "Vous pouvez désactiver les notifications dans les paramètres de votre compte.",
    "he": "אפשר לכבות התראות בהגדרות החשבון.",
    "hi": "खाता सेटिंग्स में सूचनाएँ बंद की जा सकती हैं।",
    "hy": "Ծանուցումները կարող եք անջատել հաշվի կարգավորումներում։",
    "id": "Notifikasi dapat dimatikan di pengaturan akun.",
    "it": "Puoi disattivare le notifiche nelle impostazioni dell'account.",
    "ja": "通知はアカウント設定でオフにできます。",
    "ka": "შეტყობინებების გამორთვა შესაძლებელია ანგარიშის პარამეტრებში.",
    "kk": "Хабарландыруларды жеке кабинет параметрлерінде өшіруге болады.",
    "ko": "계정 설정에서 알림을 끌 수 있습니다.",
    "pl": "Powiadomienia można wyłączyć w ustawieniach konta.",
    "pt-BR": "Você pode desativar as notificações nas configurações da conta.",
    "ro": "Poți dezactiva notificările în setările contului.",
    "sw": "Unaweza kuzima arifa katika mipangilio ya akaunti.",
    "th": "คุณสามารถปิดการแจ้งเตือนได้ในการตั้งค่าบัญชี",
    "tr": "Bildirimleri hesap ayarlarından kapatabilirsiniz.",
    "uk": "Сповіщення можна вимкнути в налаштуваннях особистого кабінету.",
    "ur": "اطلاعات اکاؤنٹ کی ترتیبات میں بند کی جا سکتی ہیں۔",
    "uz": "Bildirishnomalarni hisob sozlamalarida o'chirib qo'yish mumkin.",
    "vi": "Bạn có thể tắt thông báo trong cài đặt tài khoản.",
    "zh-Hans": "您可以在账户设置中关闭通知。",
}


# ADR-141: письмо информативно, как карточка в ЛК — кнопка ведёт в сделку,
# под текстом — мета: сделка · контрагент · сумма · этап.
OPEN_DEAL: dict[str, str] = {
    "ru": "Открыть сделку",
    "en": "Open the deal",
    "ar": "فتح الصفقة",
    "az": "Sövdələşməni aç",
    "bn": "চুক্তি খুলুন",
    "de": "Geschäft öffnen",
    "es": "Abrir el trato",
    "fa": "باز کردن معامله",
    "fr": "Ouvrir l'affaire",
    "he": "פתיחת העסקה",
    "hi": "सौदा खोलें",
    "hy": "Բացել գործարքը",
    "id": "Buka transaksi",
    "it": "Apri l'accordo",
    "ja": "取引を開く",
    "ka": "გარიგების გახსნა",
    "kk": "Мәмілені ашу",
    "ko": "거래 열기",
    "pl": "Otwórz transakcję",
    "pt-BR": "Abrir o negócio",
    "ro": "Deschide tranzacția",
    "sw": "Fungua mpango",
    "th": "เปิดข้อตกลง",
    "tr": "Anlaşmayı aç",
    "uk": "Відкрити угоду",
    "ur": "معاہدہ کھولیں",
    "uz": "Bitimni ochish",
    "vi": "Mở giao dịch",
    "zh-Hans": "打开交易",
}

META_DEAL: dict[str, str] = {
    "ru": "Сделка",
    "en": "Deal",
    "ar": "الصفقة",
    "az": "Sövdələşmə",
    "bn": "চুক্তি",
    "de": "Geschäft",
    "es": "Trato",
    "fa": "معامله",
    "fr": "Affaire",
    "he": "עסקה",
    "hi": "सौदा",
    "hy": "Գործարք",
    "id": "Transaksi",
    "it": "Accordo",
    "ja": "取引",
    "ka": "გარიგება",
    "kk": "Мәміле",
    "ko": "거래",
    "pl": "Transakcja",
    "pt-BR": "Negócio",
    "ro": "Tranzacție",
    "sw": "Mpango",
    "th": "ข้อตกลง",
    "tr": "Anlaşma",
    "uk": "Угода",
    "ur": "معاہدہ",
    "uz": "Bitim",
    "vi": "Giao dịch",
    "zh-Hans": "交易",
}

META_COUNTERPARTY: dict[str, str] = {
    "ru": "Контрагент",
    "en": "Counterparty",
    "ar": "الطرف الآخر",
    "az": "Qarşı tərəf",
    "bn": "প্রতিপক্ষ",
    "de": "Vertragspartner",
    "es": "Contraparte",
    "fa": "طرف مقابل",
    "fr": "Contrepartie",
    "he": "צד נגדי",
    "hi": "प्रतिपक्ष",
    "hy": "Գործընկեր",
    "id": "Pihak lawan",
    "it": "Controparte",
    "ja": "相手方",
    "ka": "კონტრაგენტი",
    "kk": "Контрагент",
    "ko": "상대방",
    "pl": "Kontrahent",
    "pt-BR": "Contraparte",
    "ro": "Contraparte",
    "sw": "Mhusika mwingine",
    "th": "คู่สัญญา",
    "tr": "Karşı taraf",
    "uk": "Контрагент",
    "ur": "فریقِ مخالف",
    "uz": "Kontragent",
    "vi": "Đối tác",
    "zh-Hans": "对方",
}

META_AMOUNT: dict[str, str] = {
    "ru": "Сумма",
    "en": "Amount",
    "ar": "المبلغ",
    "az": "Məbləğ",
    "bn": "পরিমাণ",
    "de": "Betrag",
    "es": "Importe",
    "fa": "مبلغ",
    "fr": "Montant",
    "he": "סכום",
    "hi": "राशि",
    "hy": "Գումար",
    "id": "Jumlah",
    "it": "Importo",
    "ja": "金額",
    "ka": "თანხა",
    "kk": "Сома",
    "ko": "금액",
    "pl": "Kwota",
    "pt-BR": "Valor",
    "ro": "Sumă",
    "sw": "Kiasi",
    "th": "จำนวนเงิน",
    "tr": "Tutar",
    "uk": "Сума",
    "ur": "رقم",
    "uz": "Summa",
    "vi": "Số tiền",
    "zh-Hans": "金额",
}

META_MILESTONE: dict[str, str] = {
    "ru": "Этап",
    "en": "Stage",
    "ar": "المرحلة",
    "az": "Mərhələ",
    "bn": "ধাপ",
    "de": "Etappe",
    "es": "Etapa",
    "fa": "مرحله",
    "fr": "Étape",
    "he": "שלב",
    "hi": "चरण",
    "hy": "Փուլ",
    "id": "Tahap",
    "it": "Fase",
    "ja": "ステージ",
    "ka": "ეტაპი",
    "kk": "Кезең",
    "ko": "단계",
    "pl": "Etap",
    "pt-BR": "Etapa",
    "ro": "Etapă",
    "sw": "Hatua",
    "th": "ขั้นตอน",
    "tr": "Aşama",
    "uk": "Етап",
    "ur": "مرحلہ",
    "uz": "Bosqich",
    "vi": "Giai đoạn",
    "zh-Hans": "阶段",
}


def open_deal_label(locale: str) -> str:
    return OPEN_DEAL.get(locale) or OPEN_DEAL["en"]


def meta_label(key: str, locale: str) -> str:
    table = {
        "deal": META_DEAL,
        "counterparty": META_COUNTERPARTY,
        "amount": META_AMOUNT,
        "milestone": META_MILESTONE,
    }[key]
    return table.get(locale) or table["en"]


def open_cabinet_label(locale: str) -> str:
    return OPEN_CABINET.get(locale) or OPEN_CABINET["en"]


def unsubscribe_hint(locale: str) -> str:
    return UNSUBSCRIBE_HINT.get(locale) or UNSUBSCRIBE_HINT["en"]


# ADR-168: письмо с кодом входа по e-mail. Это НЕ уведомление (нет получателя-
# User, нет размещения в ЛК, отключить его нельзя — оно и есть сам вход),
# поэтому строки живут здесь, рядом с остальной транспортной обвязкой письма,
# а не в l10n-паках уведомлений. Срок кода в тексте — плейсхолдер {minutes}:
# число приходит АРГУМЕНТОМ из apps.accounts (настройка
# EMAIL_OTP_CODE_TTL_SECONDS), потому что apps.notifications про настройки
# входа знать не должен. Формулировки выбраны так, чтобы быть верными при
# любом разумном значении: где язык согласует существительное с числительным
# (ar), взята форма для 11+ — дефолт 15.
LOGIN_CODE_SUBJECT: dict[str, str] = {
    "ru": "Код для входа",
    "en": "Your sign-in code",
    "ar": "رمز تسجيل الدخول",
    "az": "Giriş kodu",
    "bn": "সাইন-ইন কোড",
    "de": "Ihr Anmeldecode",
    "es": "Tu código de acceso",
    "fa": "کد ورود شما",
    "fr": "Votre code de connexion",
    "he": "קוד הכניסה שלך",
    "hi": "साइन-इन कोड",
    "hy": "Մուտքի կոդ",
    "id": "Kode masuk Anda",
    "it": "Il tuo codice di accesso",
    "ja": "ログインコード",
    "ka": "შესვლის კოდი",
    "kk": "Кіру коды",
    "ko": "로그인 코드",
    "pl": "Twój kod logowania",
    "pt-BR": "Seu código de acesso",
    "ro": "Codul tău de conectare",
    "sw": "Msimbo wako wa kuingia",
    "th": "รหัสเข้าสู่ระบบ",
    "tr": "Giriş kodunuz",
    "uk": "Код для входу",
    "ur": "سائن اِن کوڈ",
    "uz": "Kirish kodingiz",
    "vi": "Mã đăng nhập của bạn",
    "zh-Hans": "登录验证码",
}

# Текст ПОД кодом (замечание владельца 08.09 «сделай красивое письмо»): сам
# код в вёрстку приходит ОТДЕЛЬНЫМ полем и рисуется крупной плашкой, а здесь
# остаётся только приписка про срок и «если это не вы». Формулировки — те же,
# что были в едином тексте до разделения, минус фраза с самим кодом.
LOGIN_CODE_HINT: dict[str, str] = {
    "ru": "Код действует {minutes} минут. Если вы не запрашивали вход, просто не вводите его.",
    "en": "The code is valid for {minutes} minutes. "
    "If you did not request it, simply do not enter the code.",
    "ar": "الرمز صالح لمدة {minutes} دقيقة. إذا لم تطلبه، فتجاهل هذه الرسالة.",
    "az": "Kod {minutes} dəqiqə qüvvədədir. Əgər kodu siz istəməmisinizsə, sadəcə daxil etməyin.",
    "bn": "কোডটি {minutes} মিনিটের জন্য বৈধ। আপনি অনুরোধ না করে থাকলে কোডটি প্রবেশ করাবেন না।",
    "de": "Der Code ist {minutes} Minuten gültig. "
    "Wenn Sie ihn nicht angefordert haben, geben Sie ihn einfach nicht ein.",
    "es": "El código es válido durante {minutes} minutos. "
    "Si no lo solicitaste, simplemente no lo introduzcas.",
    "fa": "این کد {minutes} دقیقه اعتبار دارد. "
    "اگر آن را درخواست نکرده‌اید، کافی است آن را وارد نکنید.",
    "fr": "Le code est valable {minutes} minutes. "
    "Si vous ne l'avez pas demandé, n'en tenez pas compte.",
    "he": "הקוד תקף ל-{minutes} דקות. אם לא ביקשת אותו, פשוט אל תזין אותו.",
    "hi": "यह कोड {minutes} मिनट तक मान्य है। यदि आपने इसका अनुरोध नहीं किया है, तो कोड दर्ज न करें।",
    "hy": "Կոդը վավեր է {minutes} րոպե։ Եթե դուք այն չեք պահանջել, պարզապես մի մուտքագրեք։",
    "id": "Kode berlaku {minutes} menit. Jika Anda tidak memintanya, cukup abaikan pesan ini.",
    "it": "Il codice è valido per {minutes} minuti. Se non l'hai richiesto, non inserirlo.",
    "ja": "有効期限は{minutes}分です。心当たりがない場合は、コードを入力しないでください。",
    "ka": "კოდი მოქმედებს {minutes} წუთი. თუ არ მოგითხოვიათ, უბრალოდ არ შეიყვანოთ.",
    "kk": "Код {minutes} минут жарамды. Егер сіз сұрамаған болсаңыз, кодты енгізбеңіз.",
    "ko": "{minutes}분 동안 유효합니다. 요청하지 않으셨다면 코드를 입력하지 마세요.",
    "pl": "Kod jest ważny przez {minutes} minut. "
    "Jeśli nie prosiłeś o niego, po prostu go nie wpisuj.",
    "pt-BR": "O código é válido por {minutes} minutos. "
    "Se você não o solicitou, basta não inseri-lo.",
    "ro": "Codul este valabil {minutes} minute. "
    "Dacă nu l-ai solicitat, pur și simplu nu îl introduce.",
    "sw": "Msimbo unatumika kwa dakika {minutes}. Ikiwa hukuuomba, usiuweke.",
    "th": "รหัสใช้ได้ {minutes} นาที หากคุณไม่ได้ขอรหัสนี้ กรุณาอย่ากรอก",
    "tr": "Kod {minutes} dakika geçerlidir. Talep etmediyseniz kodu girmeyin.",
    "uk": "Код діє {minutes} хвилин. Якщо ви його не запитували, просто не вводьте його.",
    "ur": "یہ کوڈ {minutes} منٹ کے لیے کارآمد ہے۔ اگر آپ نے درخواست نہیں کی تو کوڈ درج نہ کریں۔",
    "uz": "Kod {minutes} daqiqa amal qiladi. Agar so'ramagan bo'lsangiz, kodni kiritmang.",
    "vi": "Mã có hiệu lực trong {minutes} phút. Nếu bạn không yêu cầu, hãy bỏ qua email này.",
    "zh-Hans": "验证码有效期为 {minutes} 分钟。如果这不是您本人的操作，请勿输入该验证码。",
}


def login_code_subject(locale: str) -> str:
    return LOGIN_CODE_SUBJECT.get(locale) or LOGIN_CODE_SUBJECT["en"]


def login_code_hint(locale: str, *, minutes: int) -> str:
    """Текст письма БЕЗ кода: код едет отдельным полем сообщения и рисуется
    крупной плашкой (замечание владельца 08.09). `minutes` — срок жизни кода;
    число задаёт вызывающая сторона (apps.accounts, настройка
    EMAIL_OTP_CODE_TTL_SECONDS)."""
    template = LOGIN_CODE_HINT.get(locale) or LOGIN_CODE_HINT["en"]
    return template.format(minutes=minutes)
