// React 19 requires this flag before it will treat act() as configured.
// Without it every state update in a mount test logs a warning.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
