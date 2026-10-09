import { BookOpen, Check, ChevronRight, Menu, MessageSquare, Plus, Search, Sparkles, X } from "lucide-react";
import "./_group.css";
import "./KnowledgeHub.css";

export function KnowledgeHub() {
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
        <button type="button" className="chat-knowledge-button is-active" aria-current="page">
          <span className="chat-knowledge-icon"><BookOpen size={18} strokeWidth={1.8} /></span>
          <span className="chat-knowledge-title">Knowledge Hub</span>
          <ChevronRight size={16} className="chat-knowledge-chevron" />
        </button>
        <div className="chat-history-label"><span>RECENT</span><span>2</span></div>
        <label className="conversation-search">
          <Search size={14} aria-hidden="true" />
          <input type="search" placeholder="Search chats" aria-label="Search conversations" />
          <button type="button" aria-label="Clear search"><X size={13} /></button>
        </label>
        <div className="chat-history-list">
          <div className="history-row">
            <button type="button" className="history-select">
              <MessageSquare size={15} strokeWidth={1.7} />
              <span className="history-chat-name">Where to save meeting notes</span>
            </button>
          </div>
          <div className="history-row">
            <button type="button" className="history-select">
              <MessageSquare size={15} strokeWidth={1.7} />
              <span className="history-chat-name">Orbit and gravity basics</span>
            </button>
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
            <span className="top-chat-title">Knowledge Hub</span>
          </div>
          <button type="button" className="top-new-button" aria-label="Start a new chat"><Plus size={17} /></button>
        </header>
        <div className="knowledge-hub-view">
          <div className="knowledge-hub-hero">
            <div className="knowledge-hub-mark"><BookOpen size={27} strokeWidth={1.6} /></div>
            <p className="knowledge-hub-kicker">KNOWLEDGE HUB</p>
            <h1>Knowledge Hub — Coming Soon</h1>
            <p className="knowledge-hub-subtitle">Document intelligence and RAG features are under development.</p>
          </div>
        </div>
      </main>
    </div>
  );
}
