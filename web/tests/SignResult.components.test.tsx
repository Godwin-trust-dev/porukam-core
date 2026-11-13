import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SignResult } from '@porukam/ui';

// DEV-16b §7 — «SignResult (язык-строка только в разноязычной)».
describe('SignResult (DEV-16b §3/§6)', () => {
  it('одноязычная — только чип hash, без языковой строки', () => {
    render(<SignResult chip="🔒 ver-1 · a1b2… · 31 июля 2026" />);
    expect(screen.getByText(/a1b2/)).toBeInTheDocument();
    expect(screen.queryByText(/Официальный текст/)).not.toBeInTheDocument();
  });

  it('разноязычная — чип hash + строка «Официальный текст — English»', () => {
    render(<SignResult chip="🔒 ver-1 · a1b2… · 31 июля 2026" languageNote="Официальный текст — English" />);
    expect(screen.getByText(/a1b2/)).toBeInTheDocument();
    expect(screen.getByText('Официальный текст — English')).toBeInTheDocument();
  });
});
