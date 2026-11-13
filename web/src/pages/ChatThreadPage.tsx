import { useParams } from 'react-router-dom';
import { ChatThreadPane } from '../features/chat/ChatThreadPane';

/**
 * `/chat/{contractId}` — тред переписки отдельной страницей (мобильный
 * сценарий и прямые ссылки). Вся логика — в ChatThreadPane; на десктопе
 * тот же тред открывается в detail-колонке /chat (ChatPage, DEV-19 §2).
 */
export function ChatThreadPage(): JSX.Element {
  const { contractId } = useParams<{ contractId: string }>();
  return <ChatThreadPane contractId={contractId} backTo="/chat" />;
}
