import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Checkbox,
  CookieBanner,
  HandleField,
  InviteBanner,
  RadioGroup,
  VisibilityChoice,
  type ProfileVisibilityValue,
} from '@porukam/ui';

describe('VisibilityChoice (DEV-auth-onboarding §5) — без дефолта, выбор доступен', () => {
  it('ничего не выбрано изначально (value: null) — оба варианта не отмечены', () => {
    render(
      <VisibilityChoice
        title="Who can see your profile?"
        value={null}
        onChange={() => {}}
        publicLabel="Public profile"
        publicBadge="recommended"
        linkOnlyLabel="Only by link and in deals"
        ariaLabel="Who can see your profile?"
      />,
    );
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    for (const r of radios) expect(r).toHaveAttribute('aria-checked', 'false');
  });

  it('клик по варианту вызывает onChange с его значением', async () => {
    const onChange = vi.fn();
    render(
      <VisibilityChoice
        title="Who can see your profile?"
        value={null}
        onChange={onChange}
        publicLabel="Public profile"
        linkOnlyLabel="Only by link and in deals"
        ariaLabel="Who can see your profile?"
      />,
    );
    await userEvent.click(screen.getByText('Only by link and in deals'));
    expect(onChange).toHaveBeenCalledWith('link_and_deals' satisfies ProfileVisibilityValue);
  });

  it('выбранный вариант отмечен aria-checked=true', () => {
    render(
      <VisibilityChoice
        title="Who can see your profile?"
        value="public"
        onChange={() => {}}
        publicLabel="Public profile"
        linkOnlyLabel="Only by link and in deals"
        ariaLabel="Who can see your profile?"
      />,
    );
    expect(screen.getByRole('radio', { name: /Public profile/ })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('RadioGroup — общий примитив', () => {
  it('role=radiogroup, по одному role=radio на опцию', () => {
    render(
      <RadioGroup
        ariaLabel="test"
        value={null}
        onChange={() => {}}
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ]}
      />,
    );
    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });
});

describe('HandleField (DEV-auth-onboarding §6) — статус занятости приходит снаружи', () => {
  const BASE = {
    label: '@handle',
    checkingLabel: 'Checking…',
    availableLabel: 'Available',
    takenLabel: 'Taken',
  };

  it('idle — без индикатора занятости', () => {
    render(<HandleField {...BASE} value="" onChange={() => {}} status="idle" />);
    expect(screen.queryByText('Checking…')).not.toBeInTheDocument();
    expect(screen.queryByText('Available')).not.toBeInTheDocument();
  });

  it('checking — показывает «Checking…»', () => {
    render(<HandleField {...BASE} value="godwin" onChange={() => {}} status="checking" />);
    expect(screen.getByText('Checking…')).toBeInTheDocument();
  });

  it('available — показывает «Available»', () => {
    render(<HandleField {...BASE} value="godwin" onChange={() => {}} status="available" />);
    expect(screen.getByText('Available')).toBeInTheDocument();
  });

  it('taken — показывает «Taken» и aria-invalid', () => {
    render(<HandleField {...BASE} value="godwin" onChange={() => {}} status="taken" />);
    expect(screen.getByText('Taken')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
  });

  it('ввод стрипает ведущий «@» перед вызовом onChange', async () => {
    const onChange = vi.fn();
    render(<HandleField {...BASE} value="" onChange={onChange} status="idle" />);
    await userEvent.type(screen.getByRole('textbox'), '@x');
    expect(onChange).toHaveBeenLastCalledWith('x');
  });
});

describe('InviteBanner (DEV-auth-onboarding §3) — валид/истёк', () => {
  it('валидное приглашение — заголовок, действие вызывает onAction', async () => {
    const onAction = vi.fn();
    render(
      <InviteBanner
        variant="valid"
        titleText="Alex invited you"
        actionLabel="Sign in and open the contract"
        onAction={onAction}
        expiredText="expired"
      />,
    );
    expect(screen.getByText('Alex invited you')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in and open the contract' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('истёкшее/404 приглашение — показывает expiredText, без действия', () => {
    render(<InviteBanner variant="expired" actionLabel="" onAction={() => {}} expiredText="This invite link is invalid or has expired." />);
    expect(screen.getByText('This invite link is invalid or has expired.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('CookieBanner (DEV-auth-onboarding §3) — privacy-first по умолчанию', () => {
  it('обе кнопки видны сразу — «Принять все» не дефолт, а явное действие', async () => {
    const onAcceptAll = vi.fn();
    const onNecessaryOnly = vi.fn();
    render(
      <CookieBanner
        text="By default we use only necessary cookies."
        acceptAllLabel="Accept all"
        necessaryOnlyLabel="Necessary only"
        onAcceptAll={onAcceptAll}
        onNecessaryOnly={onNecessaryOnly}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Accept all' }));
    expect(onAcceptAll).toHaveBeenCalledTimes(1);
    expect(onNecessaryOnly).not.toHaveBeenCalled();
  });
});

describe('Checkbox — не предзаполняется компонентом', () => {
  it('checked приходит только от вызывающего, клик переключает', async () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} label="I agree" />);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    await userEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
