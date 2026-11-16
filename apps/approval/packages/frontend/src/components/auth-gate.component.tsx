//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { type ReactNode } from 'react';

import { useAuth } from '@/hooks/auth.context';

interface AuthGateProps {
  children: ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const {
    isLoading,
    isAuthenticated,
    canSignIn,
    signIn,
    isSigningIn,
    signInError,
    config,
    error,
  } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="muted">Connecting to Fabric…</div>
      </div>
    );
  }

  if (config.kind === 'not-deployed') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="w-full max-w-md text-center">
          <h2 className="mb-2 text-lg font-semibold text-foreground">
            Configure this app to sign in
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Signing in needs a Fabric backend. Start{' '}
            <code className="rounded bg-muted px-1 py-0.5">npm run dev</code>{' '}
            with an approved workspace, or deploy this app, then reload.
          </p>
        </div>
      </div>
    );
  }

  if (config.kind === 'incomplete') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="w-full max-w-md text-center">
          <h2 className="mb-2 text-lg font-semibold text-foreground">
            This app is missing its Rayfin configuration
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">
            The dev server started without {config.missing.join(', ')}. Check
            the warnings it printed, then restart it.
          </p>
        </div>
      </div>
    );
  }

  if (config.kind === 'config-error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="w-full max-w-md text-center">
          <h2 className="mb-2 text-lg font-semibold text-foreground">
            Couldn't load this app's configuration
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">
            The app stopped rather than fall back to the values it was built
            with, which in a promoted environment point at the wrong backend.
            Redeploy this stage, then reload.
          </p>
          <p className="text-xs text-muted-foreground">{config.message}</p>
        </div>
      </div>
    );
  }

  if (error && !canSignIn) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center shadow-lg">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-primary">
            Fabric App
          </p>
          <h2 className="mb-2 text-lg font-semibold text-card-foreground">
            Couldn't sign you in
          </h2>
          <p className="text-sm text-muted-foreground">{error.message}</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated && canSignIn) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
        <div className="enter" style={{ width: '100%', maxWidth: 420 }}>
          <div className="brand" style={{ marginBottom: 22 }}>
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-text">Cohort data requests</span>
          </div>
          <h1 className="headline" style={{ fontSize: 30 }}>
            {error ? "Couldn't sign you in automatically" : 'Sign in to review requests'}
          </h1>
          {error ? (
            <p role="alert" className="alert">{error.message}</p>
          ) : (
            <p className="lede">
              Use your Microsoft account in the Contoso Health tenant. Decisions are recorded under the name you sign
              in with.
            </p>
          )}
          <button type="button" className="btn btn-primary" style={{ height: 38, padding: '0 18px', marginTop: 8 }}
            disabled={isSigningIn} onClick={() => void signIn()}>
            {isSigningIn ? 'Signing in…' : 'Sign in with Microsoft'}
          </button>
          {signInError ? <p role="alert" className="alert" style={{ marginTop: 16 }}>{signInError.message}</p> : null}
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="w-full max-w-md text-center">
          <h2 className="mb-2 text-lg font-semibold text-foreground">
            Sign-in is unavailable
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">
            This app requires an authenticated session. Check the authentication
            configuration, then reload to try again.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
