import { useEffect, useState } from 'react'
import { AuthView } from './features/auth/AuthView'
import { checkAuth } from './features/auth/api'
import { PlayerView } from './features/player/PlayerView'

type AuthState = 'checking' | 'anonymous' | 'authenticated'

function App() {
  const [authState, setAuthState] = useState<AuthState>('checking')

  useEffect(() => {
    async function run() {
      try {
        const authenticated = await checkAuth()
        setAuthState(authenticated ? 'authenticated' : 'anonymous')
      } catch {
        setAuthState('anonymous')
      }
    }
    void run()
  }, [])

  if (authState === 'checking') {
    return (
      <main className="flex min-h-screen items-center justify-center px-6 py-12">
        <section className="w-full max-w-sm rounded-[2rem] border border-white/10 bg-white/8 p-8 text-center shadow-2xl shadow-black/30 backdrop-blur-xl">
          <p className="text-xs font-semibold uppercase tracking-[0.35em] text-amber-200/70">
            Raspcast
          </p>
          <div className="mx-auto mt-5 h-10 w-10 animate-spin rounded-full border-2 border-white/15 border-t-amber-300" />
          <p className="mt-4 text-sm text-slate-200/80">Checking local session…</p>
        </section>
      </main>
    )
  }

  if (authState === 'anonymous')
    return <AuthView onSuccess={() => setAuthState('authenticated')} />
  return <PlayerView />
}

export default App
