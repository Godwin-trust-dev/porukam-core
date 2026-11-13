import type { StorybookConfig } from '@storybook/react-vite';
import { join } from 'node:path';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-essentials'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  core: { disableTelemetry: true },
  // Вендорные шрифты берём из web/public (единый источник, не Google Fonts).
  staticDirs: [join(__dirname, '../../../web/public')],
};

export default config;
