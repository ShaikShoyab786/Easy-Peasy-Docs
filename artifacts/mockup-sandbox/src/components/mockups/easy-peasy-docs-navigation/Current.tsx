import { ArrowUp, Check, Clock3, Menu, Plus, Search, Sparkles } from "lucide-react";
import "./_group.css";

export function Current() {
  return (
    <div className="chat-app">
      <aside className="chat-sidebar" aria-label="Chat navigation">
        <div className="chat-brand-row">
          <button type="button" className="chat-brand" aria-label="Easy Peasy Docs home">
            <span className="chat-brand-icon"><Sparkles size={17} strokeWidth={1.7} /></span>
            <span>Easy Peasy <b>Docs</b></span>
          </button>
        </div>
        <button type="button" className="chat-new-button">
          <Plus size={16} />
          <span>New chat</span>
        </button>
        <div className="chat-history-label"><span>RECENT</span><span>0</span></div>
        <label className="conversation-search">
          <Search size={14} aria-hidden="true" />
          <input type="search" placeholder="Search chats" aria-label="Search conversations" />
        </label>
        <div className="chat-history-list">
          <div className="history-blank">
            <Clock3 size={16} />
            <p>No chats yet</p>
            <span>Start a new conversation when you’re ready.</span>
          </div>
        </div>
        <div className="chat-sidebar-bottom">
          <div className="local-save"><Check size={13} /><span>History saved in this browser</span></div>
          <div className="chat-account-actions">
            <button type="button">Sign in</button>
            <button type="button" className="account-signup">Create account</button>
          </div>
        </div>
      </aside>
      <main className="chat-main">
        <header className="chat-topbar">
          <button type="button" className="sidebar-toggle-button" aria-label="Toggle sidebar"><Menu size={19} /></button>
          <div className="chat-top-title">
            <span className="chat-presence"><span /> Easy Peasy</span>
            <span className="top-title-divider">/</span>
            <span className="top-chat-title">New chat</span>
          </div>
          <button type="button" className="top-new-button" aria-label="Start a new chat"><Plus size={17} /></button>
        </header>
        <div className="chat-scroll-area is-empty">
          <div className="chat-welcome">
            <div className="welcome-mark"><Sparkles size={19} strokeWidth={1.65} /></div>
            <p className="welcome-kicker">A SPACE TO THINK</p>
            <h1>What’s on<br />your mind?</h1>
            <p className="welcome-subtitle">Ask a question, work through an idea, or start anywhere.</p>
          </div>
        </div>
        <div className="composer-dock">
          <div className="message-composer">
            <textarea rows={1} placeholder="Message Easy Peasy..." aria-label="Write a message" />
            <div className="composer-controls">
              <span>Enter to send · Shift + Enter for a new line</span>
              <button type="button" aria-label="Send message"><ArrowUp size={18} /></button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
