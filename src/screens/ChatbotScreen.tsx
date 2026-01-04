import { useState, useEffect, useRef } from 'react';
import { processQuestion, ChatMessage, isAIAvailable, getSuggestedQuestions } from '../utils/chatbot';

interface ChatbotModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ChatbotModal = ({ isOpen, onClose }: ChatbotModalProps) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [suggestedQuestions, setSuggestedQuestions] = useState<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      const available = isAIAvailable();
      setAiAvailable(available);
      setSuggestedQuestions(getSuggestedQuestions());
      
      // Only add welcome message if no messages yet
      if (messages.length === 0) {
        const welcomeMessage: ChatMessage = {
          id: 'welcome',
          role: 'assistant',
          content: available 
            ? 'היי! 👋 שאל אותי כל שאלה על המשחקים - מי מוביל, מי ניצח, איפה שיחקתם, סטטיסטיקות, וכל מה שמעניין אותך!'
            : 'כדי להשתמש בצ\'אט, צריך להגדיר מפתח Gemini API בהגדרות.',
          timestamp: new Date(),
          source: 'local',
        };
        setMessages([welcomeMessage]);
      }
      
      // Focus input when opening
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen, messages.length]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleSend = async (text?: string) => {
    const messageText = text || input.trim();
    if (!messageText || isProcessing) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: messageText,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsProcessing(true);

    try {
      const result = await processQuestion(messageText);
      
      const assistantMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: result.answer,
        timestamp: new Date(),
        source: result.source,
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      const errorMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: 'סליחה, משהו השתבש. נסה שוב.',
        timestamp: new Date(),
        source: 'local',
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSuggestedQuestion = (question: string) => {
    handleSend(question);
  };

  if (!isOpen) return null;

  const showSuggestions = messages.length === 1 && aiAvailable;

  return (
    <div 
      className="modal-overlay" 
      onClick={onClose}
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        padding: '0',
      }}
    >
      <div 
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: '500px',
          height: '85vh',
          maxHeight: '700px',
          background: 'var(--background)',
          borderRadius: '20px 20px 0 0',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'slideUp 0.3s ease-out',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '1rem 1.25rem',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'linear-gradient(135deg, #8B5CF6, #7C3AED)',
          color: 'white',
        }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: '600' }}>💬 שאל אותי הכל</h3>
            <span style={{ fontSize: '0.75rem', opacity: 0.9 }}>
              {aiAvailable ? 'AI מוכן לענות' : 'נדרש מפתח API'}
            </span>
          </div>
          <button 
            onClick={onClose}
            style={{
              background: 'rgba(255,255,255,0.2)',
              border: 'none',
              fontSize: '1.2rem',
              cursor: 'pointer',
              color: 'white',
              padding: '0.5rem',
              borderRadius: '50%',
              width: '36px',
              height: '36px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ✕
          </button>
        </div>

        {/* Messages area */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '1rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem',
        }}>
          {messages.map(msg => (
            <div
              key={msg.id}
              style={{
                display: 'flex',
                justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
              }}
            >
              <div
                style={{
                  maxWidth: '85%',
                  padding: '0.75rem 1rem',
                  borderRadius: msg.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                  background: msg.role === 'user'
                    ? 'linear-gradient(135deg, #3B82F6, #2563EB)'
                    : 'var(--surface)',
                  color: msg.role === 'user' ? 'white' : 'var(--text)',
                  border: msg.role === 'assistant' ? '1px solid var(--border)' : 'none',
                  boxShadow: msg.role === 'user' 
                    ? '0 2px 8px rgba(59, 130, 246, 0.3)' 
                    : '0 2px 4px rgba(0,0,0,0.08)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: '0.95rem',
                  lineHeight: '1.6',
                }}
              >
                {msg.content}
              </div>
            </div>
          ))}
          
          {isProcessing && (
            <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
              <div style={{
                padding: '0.75rem 1rem',
                borderRadius: '16px 16px 16px 4px',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                fontSize: '0.9rem',
              }}>
                <span className="loading-dots">חושב</span>
              </div>
            </div>
          )}
          
          <div ref={messagesEndRef} />
        </div>

        {/* Suggested questions */}
        {showSuggestions && (
          <div style={{ 
            padding: '0.5rem 1rem 0.75rem',
            borderTop: '1px solid var(--border)',
            background: 'var(--surface)',
          }}>
            <div style={{ 
              fontSize: '0.75rem', 
              color: 'var(--text-muted)', 
              marginBottom: '0.5rem',
              fontWeight: '500',
            }}>
              💡 נסה לשאול:
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
              {suggestedQuestions.map((q, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSuggestedQuestion(q)}
                  style={{
                    padding: '0.5rem 0.75rem',
                    borderRadius: '20px',
                    background: 'var(--background)',
                    border: '1px solid var(--border)',
                    color: 'var(--text)',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Input area */}
        <div style={{
          padding: '0.75rem 1rem 1rem',
          borderTop: '1px solid var(--border)',
          background: 'var(--surface)',
        }}>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder={aiAvailable ? "שאל כל שאלה..." : "נדרש מפתח API"}
              disabled={!aiAvailable}
              style={{
                flex: 1,
                padding: '0.875rem 1rem',
                borderRadius: '24px',
                border: '1px solid var(--border)',
                background: 'var(--background)',
                color: 'var(--text)',
                fontSize: '1rem',
                fontFamily: 'inherit',
                outline: 'none',
              }}
            />
            <button
              onClick={() => handleSend()}
              disabled={!input.trim() || isProcessing || !aiAvailable}
              style={{
                padding: '0.875rem',
                borderRadius: '50%',
                width: '48px',
                height: '48px',
                background: input.trim() && !isProcessing && aiAvailable
                  ? 'linear-gradient(135deg, #8B5CF6, #7C3AED)'
                  : 'var(--border)',
                color: input.trim() && !isProcessing && aiAvailable ? 'white' : 'var(--text-muted)',
                border: 'none',
                fontSize: '1.25rem',
                cursor: input.trim() && !isProcessing && aiAvailable ? 'pointer' : 'not-allowed',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.2s',
              }}
            >
              ➤
            </button>
          </div>
        </div>
      </div>
      
      <style>{`
        .loading-dots::after {
          content: '';
          animation: dots 1.5s steps(4, end) infinite;
        }
        @keyframes dots {
          0%, 20% { content: ''; }
          40% { content: '.'; }
          60% { content: '..'; }
          80%, 100% { content: '...'; }
        }
      `}</style>
    </div>
  );
};

// Floating Action Button component
export const ChatFAB = ({ onClick }: { onClick: () => void }) => {
  return (
    <button
      onClick={onClick}
      style={{
        position: 'fixed',
        bottom: '80px',
        right: '16px',
        width: '56px',
        height: '56px',
        borderRadius: '50%',
        background: 'linear-gradient(135deg, #8B5CF6, #7C3AED)',
        border: 'none',
        boxShadow: '0 4px 16px rgba(139, 92, 246, 0.4)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '1.5rem',
        color: 'white',
        zIndex: 90,
        transition: 'transform 0.2s, box-shadow 0.2s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'scale(1.1)';
        e.currentTarget.style.boxShadow = '0 6px 20px rgba(139, 92, 246, 0.5)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'scale(1)';
        e.currentTarget.style.boxShadow = '0 4px 16px rgba(139, 92, 246, 0.4)';
      }}
    >
      💬
    </button>
  );
};

// Old screen component - kept for backwards compatibility but not used
const ChatbotScreen = () => {
  return null;
};

export default ChatbotScreen;
