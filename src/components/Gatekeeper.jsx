import React, { useEffect, useState } from 'react';
import { checkSubscription } from '../services/auth.js';
import Paywall from './Paywall.jsx';

export default function Gatekeeper({ children }) {
    const [gate, setGate] = useState('loading');

    useEffect(() => {
        checkSubscription().then(result => {
            setGate(result === 'approved' ? 'approved' : 'denied');
        });
    }, []);

    if (gate === 'loading') return <LoadingScreen />;
    if (gate === 'denied')  return <Paywall onApproved={() => setGate('approved')} />;
    return children;
}

function LoadingScreen() {
    return (
        <div style={{ minHeight: '100vh', width: '100%', background: '#09090b', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
                <div style={{
                    width: '24px', height: '24px', borderRadius: '50%',
                    border: '2px solid #3f3f46', borderTopColor: '#d4d4d8',
                    animation: 'vitro-spin 0.8s linear infinite'
                }} />
                <p style={{ fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.3em', color: '#52525b', margin: 0 }}>
                    Verifying access
                </p>
            </div>
            <style>{`@keyframes vitro-spin { to { transform: rotate(360deg); } }`}</style>
        </div>
    );
}
