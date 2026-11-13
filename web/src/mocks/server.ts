import { setupServer } from 'msw/node';
import { handlers } from './handlers';

/** MSW-сервер для vitest/jsdom (ТЗ §15: мок-сервер на тех же хендлерах). */
export const server = setupServer(...handlers);
