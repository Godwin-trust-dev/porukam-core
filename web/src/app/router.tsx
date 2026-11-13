import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom';
import { RequireAuth } from '../features/auth/RequireAuth';
import { PHONE_LOGIN_ENABLED } from '../features/auth/phoneLoginFlag';
import { EMAIL_LOGIN_ENABLED } from '../features/auth/emailLoginFlag';
import { LoginPage } from '../pages/LoginPage';
import { EmailLoginPage } from '../pages/EmailLoginPage';
import { WelcomePage } from '../pages/auth/WelcomePage';
import { GoogleMockPage } from '../pages/auth/GoogleMockPage';
import { AuthCallbackPage } from '../pages/auth/AuthCallbackPage';
import { DriveConnectCallbackPage } from '../pages/settings/DriveConnectCallbackPage';
import { ConsentsPage } from '../pages/onboarding/ConsentsPage';
import { ProfileStepPage } from '../pages/onboarding/ProfileStepPage';
import { BackupStepPage } from '../pages/onboarding/BackupStepPage';
import { publicRoutes } from '../features/publicSite/PublicRoutes';
import { ShellOrLanding } from '../features/publicSite/ShellOrLanding';
import { DashboardPage } from '../pages/DashboardPage';
import { ContractsListPage } from '../pages/ContractsListPage';
import { NotificationsPage } from '../pages/NotificationsPage';
import { OwnerProfilePage } from '../pages/OwnerProfilePage';
import { PortfolioPage } from '../pages/PortfolioPage';
import { ContactsPage } from '../pages/ContactsPage';
import { AboutPage } from '../pages/help/AboutPage';
import { FaqPage } from '../pages/help/FaqPage';
import { EsicaStubPage } from '../pages/EsicaStubPage';
import { SectionEmptyPage } from '../pages/SectionEmptyPage';
import { ChatPage } from '../pages/ChatPage';
import { ChatInquiryPage } from '../pages/ChatInquiryPage';
import { ChatThreadPage } from '../pages/ChatThreadPage';
import { SearchPage } from '../pages/SearchPage';
import { GroupsPage } from '../pages/GroupsPage';
import { GroupDetailPage } from '../pages/GroupDetailPage';
import { StagesPage } from '../pages/StagesPage';
import { PaymentsPage } from '../pages/PaymentsPage';
import { DisputesPage } from '../pages/DisputesPage';
import { DisputePage } from '../pages/DisputePage';
import { MyReputationPage } from '../pages/MyReputationPage';
import { ReputationInsightsPage } from '../pages/ReputationInsightsPage';
import { ContractNewPage } from '../pages/contract-new/ContractNewPage';
import { TypeStep } from '../pages/contract-new/TypeStep';
import { SphereStep } from '../pages/contract-new/SphereStep';
import { PartiesStepPage } from '../pages/contract-new/PartiesStepPage';
import { DetailsStepPage } from '../pages/contract-new/DetailsStepPage';
import { StagesStepPage } from '../pages/contract-new/StagesStepPage';
import { TermsStepPage } from '../pages/contract-new/TermsStepPage';
import { PreviewStepPage } from '../pages/contract-new/PreviewStepPage';
import { ContractDetailPage } from '../pages/ContractDetailPage';
import { ShellErrorBoundary } from '../pages/RouteErrorPage';
import { ContractReviewPage } from '../pages/ContractReviewPage';
import {
  ContractPage,
  ContractOverviewTab,
  ContractStagesTab,
  ContractMoneyTab,
  ContractHistoryTab,
} from '../pages/ContractPage';
import { AcceptancePage } from '../pages/AcceptancePage';
import { ArchivePage } from '../pages/ArchivePage';
import { StagePage } from '../pages/StagePage';
import { PaymentPage } from '../pages/PaymentPage';
import { SigningPage } from '../pages/SigningPage';
import { AmendmentPage } from '../pages/AmendmentPage';
import { ReputationCardPage } from '../pages/ReputationCardPage';
import { LegalDocumentPage, LegalTosRedirect } from '../pages/LegalDocumentPage';
import { AccountDeletionPage } from '../pages/AccountDeletionPage';
import { ArchiveLinkPage } from '../pages/ArchiveLinkPage';
import { SettingsIndex } from '../pages/settings/SettingsIndex';
import { SettingsLayout } from '../pages/settings/SettingsLayout';
import { ProfileSettingsPage } from '../pages/settings/ProfileSettingsPage';
import { PrivacySettingsPage } from '../pages/settings/PrivacySettingsPage';
import { NotificationsSettingsPage } from '../pages/settings/NotificationsSettingsPage';
import { AppSettingsPage } from '../pages/settings/AppSettingsPage';
import { AccountSettingsPage } from '../pages/settings/AccountSettingsPage';
import { GroupSettingsPage } from '../pages/settings/GroupSettingsPage';
import { DeleteAccountPage } from '../pages/settings/DeleteAccountPage';

export const router = createBrowserRouter([
  // GLOBAL У1 (DEV-auth-onboarding §1): вход только Google, без телефона/пароля.
  // /login (телефон/OTP) на время ГВ спрятан за PHONE_LOGIN_ENABLED — код цел
  // (docs/tasks/Задача_feat_web-global-entry.md §2), маршрут просто отдаёт
  // /welcome вместо LoginPage, когда флаг выключен (прод-сборка).
  { path: '/login', element: PHONE_LOGIN_ENABLED ? <LoginPage /> : <Navigate to="/welcome" replace /> },
  // Вход/регистрация по e-mail кодом (ADR-168, решение владельца 06.09.2026):
  // «вход только через Google» смягчён до «Google + почта». В отличие от
  // телефонного флаг ВКЛЮЧЁН по умолчанию всюду, включая прод-образ, — `'0'`
  // остаётся аварийным рубильником (web/src/features/auth/emailLoginFlag.ts).
  {
    path: '/login/email',
    element: EMAIL_LOGIN_ENABLED ? <EmailLoginPage /> : <Navigate to="/welcome" replace />,
  },
  // Публичные — как /login, пользователя ещё нет на /welcome и /auth/*.
  { path: '/welcome', element: <WelcomePage /> },
  { path: '/auth/google/mock', element: <GoogleMockPage /> },
  // Боевой redirect_uri логина (GOOGLE_OAUTH_LOGIN_REDIRECT_URI, ГВ.2) — путь
  // выбран консистентным с Drive-конвенцией (/settings/drive/callback) ниже:
  // выделенный /auth/google/callback, не общий /auth/callback (docs/tasks/
  // Задача_feat_web-oauth-callbacks.md §2.2, вариант Б).
  { path: '/auth/google/callback', element: <AuthCallbackPage /> },
  // Юр-документы отдельными ПУБЛИЧНЫМИ страницами (`?lang=` — язык в ссылке):
  // Google Play и App Store требуют ссылку на политику конфиденциальности,
  // открывающуюся у постороннего человека без входа. Шторка внутри SPA такой
  // ссылкой быть не может. Текст тот же, источник тот же — GET /v1/legal/<doc>.
  // ПЕРЕД generic-маршрутом `/legal/:doc`: Google Play требует для приложений с
  // аккаунтами публичную страницу с пошаговой инструкцией удаления аккаунта, и
  // это НЕ юр-документ с бэкенда (`GET /v1/legal/<doc>`), а описание поведения
  // самого клиента — статическая страница на ключах интерфейса (ADR-169).
  // React Router v6 берёт БОЛЕЕ СПЕЦИФИЧНЫЙ маршрут независимо от порядка, но
  // порядок здесь ещё и читается как «сначала конкретный, потом остальные».
  { path: '/legal/account-deletion', element: <AccountDeletionPage /> },
  // `/legal/tos` — прежний (ошибочный) адрес из подвала, мог разойтись по внешним
  // ссылкам; ведёт на условия с сохранением `?lang=`.
  { path: '/legal/tos', element: <LegalTosRedirect /> },
  { path: '/legal/:doc', element: <LegalDocumentPage /> },
  // Долгоживущая ссылка на архив `/a/<token>` (ADR-139 §7) — НЕ маршрут SPA:
  // её обслуживает бэкенд, nginx проксирует `/a/` в core. Маршрут существует
  // только как страховка от УСТАРЕВШЕГО service worker'а, который до правки от
  // 03.09 подменял такую навигацию оболочкой из precache (docs/backlog.md);
  // страница снимает регистрацию SW и повторяет переход уже в сеть.
  { path: '/a/*', element: <ArchiveLinkPage /> },
  {
    // Приём callback реального Drive-OAuth (ADR-084) — уже авторизованный
    // пользователь (IsAuthenticated на бэке), поэтому под RequireAuth, но вне
    // ShellLayout — как AuthCallbackPage, экрану не нужна навигационная рамка.
    path: '/settings/drive/callback',
    element: (
      <RequireAuth>
        <DriveConnectCallbackPage />
      </RequireAuth>
    ),
  },
  {
    // Онбординг — уже авторизован (Google), но ещё не внутри приложения:
    // RequireAuth без RequireGlobalOnboarding (иначе — бесконечный редирект).
    path: '/onboarding',
    element: (
      <RequireAuth>
        <Outlet />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <Navigate to="consents" replace /> },
      { path: 'consents', element: <ConsentsPage /> },
      { path: 'profile', element: <ProfileStepPage /> },
      { path: 'backup', element: <BackupStepPage /> },
    ],
  },
  // Публичный контур (ADR-195): лендинг и страницы о проекте без входа, язык
  // в адресе (`/about` — английский апекс, `/ru/about` — русский). Список
  // собирается из реестра страниц и реестра локалей — см. `publicRoutes`.
  // Объявлены ДО `/:handle` ниже: статический сегмент в React Router v6 и так
  // приоритетнее параметра, но порядок читается как «сначала известные пути».
  ...publicRoutes(),
  // Публичная карточка репутации (DEV-01 §1): без авторизации, вне оболочки — гость должен её видеть.
  // React Router v6 не умеет матчить статичный префикс + параметр в одном сегменте («/@:handle»),
  // поэтому маршрут принимает весь сегмент, а «@»-префикс проверяется внутри страницы.
  { path: '/:handle', element: <ReputationCardPage /> },
  {
    path: '/',
    // Гость на `/` видит лендинг, залогиненный — рабочий стол, установленное
    // приложение — экран входа. Все три случая разводит `ShellOrLanding`
    // (ADR-195); для вложенных маршрутов оболочки поведение не изменилось.
    element: <ShellOrLanding />,
    children: [
      {
        // Отсмотр 2026-08-21: единый рубеж ошибок для ВСЕХ экранов оболочки —
        // pathless-layout, чтобы ошибка рисовалась внутри ShellLayout, а не
        // вместо него (white-screen «Unexpected Application Error!»).
        element: <ShellErrorBoundary />,
        children: [
          { index: true, element: <DashboardPage /> },
          // DEV-13 — список сделок; /deals — старый Ф1-путь, оставлен редиректом ради ссылок.
          { path: 'contracts', element: <ContractsListPage /> },
          { path: 'deals', element: <Navigate to="/contracts" replace /> },
          { path: 'notifications', element: <NotificationsPage /> },
          {
            // DEV-09 — мастер создания договора: шаги как под-маршруты, автосейв на каждом.
            path: 'contracts/new',
            element: <ContractNewPage />,
            children: [
              { index: true, element: <Navigate to="type" replace /> },
              { path: 'type', element: <TypeStep /> },
              { path: 'sphere', element: <SphereStep /> },
              { path: 'parties', element: <PartiesStepPage /> },
              { path: 'details', element: <DetailsStepPage /> },
              { path: 'stages', element: <StagesStepPage /> },
              { path: 'terms', element: <TermsStepPage /> },
              { path: 'preview', element: <PreviewStepPage /> },
            ],
          },
          {
            path: 'contracts/:id',
            children: [
              { index: true, element: <ContractDetailPage /> },
              {
                element: <ContractPage />,
                children: [
                  { path: 'overview', element: <ContractOverviewTab /> },
                  { path: 'stages', element: <ContractStagesTab /> },
                  { path: 'money', element: <ContractMoneyTab /> },
                  { path: 'history', element: <ContractHistoryTab /> },
                ],
              },
            ],
          },
          { path: 'contracts/:id/milestones/:mid/accept', element: <AcceptancePage /> },
          { path: 'contracts/:id/archive', element: <ArchivePage /> },
          { path: 'contracts/:id/stages/:sid', element: <StagePage /> },
          { path: 'contracts/:id/payments/:pid', element: <PaymentPage /> },
          { path: 'contracts/:id/review', element: <ContractReviewPage /> },
          { path: 'contracts/:id/sign', element: <SigningPage /> },
          // Допсоглашение (Э4.5 бэкенда, ADR-131 §3 — скидка по спору тоже
          // допник): просмотр «было/стало», подпись на замороженной версии.
          { path: 'contracts/:id/amendments/:amendmentId', element: <AmendmentPage /> },
          { path: 'me', element: <OwnerProfilePage /> },
          // ADR-115: портфолио стало реальным (проекты + фото-обложки).
          { path: 'me/portfolio', element: <PortfolioPage /> },
          { path: 'me/contacts', element: <ContactsPage /> },
          // ADR-163 §8: приватный разбор своей репутации. Живёт под `/me`,
          // а не рядом с карточкой: карточка публична (её открывают и
          // гости по `/@handle`), разбор — только свой.
          { path: 'me/reputation', element: <ReputationInsightsPage /> },
          { path: 'help/about', element: <AboutPage /> },
          { path: 'help/faq', element: <FaqPage /> },
          { path: 'me/verify/esica', element: <EsicaStubPage /> },
          {
            path: 'me/settings',
            element: <SettingsLayout />,
            children: [
              // Узкий экран — хаб разделов строками, десктоп — сразу первый
              // раздел (SettingsIndex решает по ширине, адрес один).
              { index: true, element: <SettingsIndex /> },
              { path: 'profile', element: <ProfileSettingsPage /> },
              // ADR-129: настройки активного актёра-объединения (витрина,
              // логотип, хендл) — переехали сюда из карточки /groups/{id}.
              { path: 'group', element: <GroupSettingsPage /> },
              { path: 'privacy', element: <PrivacySettingsPage /> },
              { path: 'notifications', element: <NotificationsSettingsPage /> },
              { path: 'app', element: <AppSettingsPage /> },
              // Отсмотр 2026-08-21: «Безопасность» скрыта (только Google-вход) —
              // прямые ссылки уводим в профиль, pages/settings/SecuritySettingsPage цела.
              { path: 'security', element: <Navigate to="/me/settings/profile" replace /> },
              { path: 'account', element: <AccountSettingsPage /> },
              { path: 'account/delete', element: <DeleteAccountPage /> },
            ],
          },
          // /feed = уведомления под другим именем (бэклог, решение 2026-08-23):
          // своя агрегация дублировала бы GET /v1/notifications — редирект,
          // пункт «Лента» в навигации заменён «Главной» (`/`, рабочий стол).
          { path: 'feed', element: <Navigate to="/notifications" replace /> },
          // ADR-114: поиск людей (@хендл/телефон) и объединений с гео-зонами.
          { path: 'search', element: <SearchPage /> },
          { path: 'stages', element: <StagesPage /> },
          { path: 'payments', element: <PaymentsPage /> },
          { path: 'disputes', element: <DisputesPage /> },
          // Карточка разногласия (этап 7, ADR-131): лента, окна оспаривания и
          // действия по роли — вход из раздела и из уведомлений.
          { path: 'disputes/:disputeId', element: <DisputePage /> },
          { path: 'reputation', element: <MyReputationPage /> },
          // Карточка по profile_id (ADR-093) — ВНУТРИ оболочки (отсмотр
          // 2026-08-23: «пропадает боковая панель»): в приложение по этой
          // ссылке ходят только авторизованные (раздел «Репутация», строки
          // договоров, контакты). Публичный гостевой вход — «/@handle» выше.
          { path: 'reputation/profiles/:profileId', element: <ReputationCardPage /> },
          // ADR-112: чат по договорам — список диалогов + тред.
          { path: 'chat', element: <ChatPage /> },
          { path: 'chat/new', element: <ChatInquiryPage /> },
          { path: 'chat/:contractId', element: <ChatThreadPage /> },
          // Отсмотр 2026-08-23: объединения — список/страница, вход/заявки.
          { path: 'groups', element: <GroupsPage /> },
          { path: 'groups/:groupId', element: <GroupDetailPage /> },
          { path: 'organizations/new', element: <SectionEmptyPage section="organizations" icon="contract" /> },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/contracts" replace /> },
]);
