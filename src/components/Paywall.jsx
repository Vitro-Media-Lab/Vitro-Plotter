import React, { useState } from 'react';
import { loginUser, checkSubscription } from '../services/auth.js';

const SHOP_URL = 'https://www.vitromedialab.com/designs';

export default function Paywall({ onApproved }) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [status,   setStatus]   = useState('idle'); // idle | loading | no_subscription | error
    const [errorMsg, setErrorMsg] = useState('');

    async function handleSubmit(e) {
        e.preventDefault();
        setStatus('loading');
        setErrorMsg('');

        try {
            await loginUser(username, password);
            const result = await checkSubscription();
            if (result === 'approved') {
                onApproved();
            } else {
                setStatus('no_subscription');
            }
        } catch (err) {
            setStatus('error');
            setErrorMsg(err.message ?? 'Something went wrong.');
        }
    }

    return (
        <div className="min-h-screen w-full bg-zinc-950 flex items-center justify-center p-6">
            <div className="w-full max-w-sm">

                {/* Wordmark */}
                <div className="mb-10 text-center">
                    <p className="text-[10px] tracking-[0.3em] uppercase text-zinc-500 mb-1">
                        Vitro Media Lab
                    </p>
                    <h1 className="text-2xl font-light tracking-tight text-zinc-100">
                        Pen Plotter
                    </h1>
                </div>

                {/* Access gate notice */}
                <div className="mb-8 rounded border border-zinc-800 bg-zinc-900 px-5 py-4 text-center">
                    <p className="text-[11px] text-zinc-400 leading-relaxed">
                        An active{' '}
                        <span className="text-zinc-200">Vitro Media Lab subscription</span>
                        {' '}is required to use this tool.
                    </p>
                    <a
                        href={SHOP_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-4 inline-block w-full rounded bg-zinc-100 px-4 py-2.5 text-[11px] font-medium tracking-widest uppercase text-zinc-900 hover:bg-white transition-colors"
                    >
                        Get Access
                    </a>
                </div>

                {/* Login form */}
                <form onSubmit={handleSubmit} className="space-y-3">
                    <div>
                        <label className="block text-[9px] uppercase tracking-widest text-zinc-500 mb-1.5">
                            Username or Email
                        </label>
                        <input
                            type="text"
                            autoComplete="username"
                            required
                            value={username}
                            onChange={e => setUsername(e.target.value)}
                            className="w-full rounded bg-zinc-900 border border-zinc-800 px-3 py-2 text-[12px] text-zinc-200 placeholder-zinc-700 focus:outline-none focus:border-zinc-600 transition-colors"
                        />
                    </div>
                    <div>
                        <label className="block text-[9px] uppercase tracking-widest text-zinc-500 mb-1.5">
                            Password
                        </label>
                        <input
                            type="password"
                            autoComplete="current-password"
                            required
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            className="w-full rounded bg-zinc-900 border border-zinc-800 px-3 py-2 text-[12px] text-zinc-200 placeholder-zinc-700 focus:outline-none focus:border-zinc-600 transition-colors"
                        />
                    </div>

                    {status === 'no_subscription' && (
                        <p className="text-[10px] text-amber-400 pt-1">
                            No active subscription found on this account.{' '}
                            <a href={SHOP_URL} target="_blank" rel="noopener noreferrer"
                               className="underline hover:text-amber-300">
                                Purchase access.
                            </a>
                        </p>
                    )}
                    {status === 'error' && (
                        <p className="text-[10px] text-red-400 pt-1">{errorMsg}</p>
                    )}

                    <button
                        type="submit"
                        disabled={status === 'loading'}
                        className="w-full rounded border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-[11px] font-medium tracking-widest uppercase text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors mt-1"
                    >
                        {status === 'loading' ? 'Verifying…' : 'Sign In'}
                    </button>
                </form>

            </div>
        </div>
    );
}
