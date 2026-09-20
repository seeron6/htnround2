// Labs share .local for models and keys, so explicitly opt out of the demo's DSNs.
export function videoLabTelemetry(env) {
  const disabled = env.CONTACT_VIDEO_SENTRY === '1' ? '0' : '1';
  const environment = env.SENTRY_ENVIRONMENT || 'video-lab';
  return {
    SENTRY_DISABLED: disabled,
    VITE_SENTRY_DISABLED: disabled,
    SENTRY_ENVIRONMENT: environment,
    VITE_SENTRY_ENVIRONMENT: environment,
  };
}
