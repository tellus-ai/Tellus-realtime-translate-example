import { act, createElement } from 'react';
import { Switch, Text } from 'react-native';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { DenoiseStatus, DenoiseToggle } from '../src/components/DenoiseControl';
import type { DenoiseSnapshot } from '../src/realtime/types';

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment; });
const snapshot: DenoiseSnapshot = { enabled: true, applied: null, updating: false, error: null };

it('forwards denoise selection and blocks input while the SDK is changing or unavailable', async () => {
  const onChange = jest.fn();
  const props = { snapshot, disabled: false, audioSdkEnabled: true, onChange };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(DenoiseToggle, props)); });
  expect(renderer.root.findByType(Switch).props.value).toBe(true);
  expect(renderer.root.findByType(Switch).props.disabled).toBe(false);
  await act(async () => { renderer.root.findByType(Switch).props.onValueChange(false); });
  expect(onChange).toHaveBeenCalledWith(false);

  for (const change of [{ disabled: true }, { audioSdkEnabled: false }, { snapshot: { ...snapshot, updating: true } }]) {
    onChange.mockClear();
    await act(async () => { renderer.update(createElement(DenoiseToggle, { ...props, ...change })); });
    expect(renderer.root.findByType(Switch).props.disabled).toBe(true);
    await act(async () => { renderer.root.findByType(Switch).props.onValueChange(false); });
    expect(onChange).not.toHaveBeenCalled();
  }
  await act(async () => { renderer.unmount(); });
});

it('shows the applied SDK value separately from the selection and announces failures', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(DenoiseStatus, { snapshot, audioSdkEnabled: true })); });
  const text = () => renderer.root.findAllByType(Text).flatMap((node) => node.props.children).join('');
  expect(text()).toContain('Not started · On selected');
  await act(async () => { renderer.update(createElement(DenoiseStatus, {
    snapshot: { ...snapshot, applied: false, error: 'Unable to change denoise' }, audioSdkEnabled: true,
  })); });
  expect(text()).toContain('Audio SDK denoise: Off');
  expect(renderer.root.findAllByType(Text).some((node) => node.props.accessibilityRole === 'alert')).toBe(true);
  await act(async () => { renderer.unmount(); });
});
