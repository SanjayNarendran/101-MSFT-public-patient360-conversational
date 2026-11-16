//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { createRoot } from 'react-dom/client';

import { Root } from './Root';
import { bootstrapAuth } from './services/rayfin-auth.service';

import './global.css';

// The theme chosen last time, before the first paint.
try {
  const saved = localStorage.getItem('cohort-theme');
  if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
} catch {
  /* private mode */
}

const rayfinAuthService = await bootstrapAuth();

createRoot(document.getElementById('root')!).render(
  <Root rayfinAuthService={rayfinAuthService} />
);
