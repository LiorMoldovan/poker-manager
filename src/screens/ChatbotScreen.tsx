import { useState, useEffect, useRef } from 'react';
import { processQuestion, ChatMessage, isAIAvailable } from '../utils/chatbot';

interface ChatbotModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ChatbotModal = ({ isOpen, onClose }: ChatbotModalProps) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen && messages.length === 0) {
      const available = isAIAvailable();
      setAiAvailable(available);
      
      // Add welcome message
      const welcomeMessage: ChatMessage = {
        id: 'welcome',
        role: 'assistant',
        content: 'שאל אותי כל שאלה על המשחקים שלכם! 🎯',
        timestamp: new Date(),
        source: 'local',
      };
      setMessages([welcomeMessage]);
    }
  }, [isOpen, messages.length]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleSend = async () => {
    if (!input.trim() || isProcessing) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: input.trim(),
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsProcessing(true);

    try {
      const result = await processQuestion(userMessage.content);
      
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
        content: 'סליחה, אירעה שגיאה. נסה שוב.',
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

  const suggestedQuestions = [
    'איפה היה המשחק האחרון?',
    'מי סיים אחרון במשחק האחרון?',
    'מי המוביל בטבלה?',
    'מי ניצח במשחק האחרון?',
  ];

  if (!isOpen) return null;

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
          height: '80vh',
          maxHeight: '600px',
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
          padding: '1rem',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'var(--surface)',
        }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1.1rem' }}>💬 שאל אותי</h3>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              {aiAvailable ? '🤖 AI פעיל' : '📱 מצב מקומי'}
            </span>
          </div>
          <button 
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '1.5rem',
              cursor: 'pointer',
              color: 'var(--text-muted)',
              padding: '0.25rem',
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
                  borderRadius: '12px',
                  background: msg.role === 'user'
                    ? 'linear-gradient(135deg, #3B82F6, #2563EB)'
                    : 'var(--surface)',
                  color: msg.role === 'user' ? 'white' : 'var(--text)',
                  border: msg.role === 'assistant' ? '1px solid var(--border)' : 'none',
                  boxShadow: msg.role === 'user' ? '0 2px 8px rgba(59, 130, 246, 0.3)' : '0 2px 4px rgba(0,0,0,0.1)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: '0.95rem',
                  lineHeight: '1.5',
                }}
              >
                {msg.content}
                {msg.role === 'assistant' && msg.source && msg.id !== 'welcome' && (
                  <div style={{
                    fontSize: '0.65rem',
                    opacity: 0.6,
                    marginTop: '0.4rem',
                  }}>
                    {msg.source === 'ai' ? '🤖' : '📱'}
                  </div>
                )}
              </div>
            </div>
          ))}
          
          {isProcessing && (
            <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
              <div style={{
                padding: '0.75rem 1rem',
                borderRadius: '12px',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                fontSize: '0.9rem',
              }}>
                <span>💭</span>
                <span>חושב...</span>
              </div>
            </div>
          )}
          
          <div ref={messagesEndRef} />
        </div>

        {/* Suggested questions */}
        {messages.length === 1 && (
          <div style={{ padding: '0 1rem 0.5rem' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
              {suggestedQuestions.map((q, idx) => (
                <button
                  key={idx}
                  onClick={() => setInput(q)}
                  style={{
                    padding: '0.4rem 0.6rem',
                    borderRadius: '8px',
                    background: 'var(--surface)',
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
          padding: '0.75rem 1rem',
          borderTop: '1px solid var(--border)',
          background: 'var(--surface)',
        }}>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="שאל שאלה..."
              style={{
                flex: 1,
                padding: '0.75rem',
                borderRadius: '12px',
                border: '1px solid var(--border)',
                background: 'var(--background)',
                color: 'var(--text)',
                fontSize: '1rem',
                fontFamily: 'inherit',
              }}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || isProcessing}
              style={{
                padding: '0.75rem 1.25rem',
                borderRadius: '12px',
                background: input.trim() && !isProcessing
                  ? 'linear-gradient(135deg, #3B82F6, #2563EB)'
                  : 'var(--border)',
                color: input.trim() && !isProcessing ? 'white' : 'var(--text-muted)',
                border: 'none',
                fontSize: '1rem',
                fontWeight: '500',
                cursor: input.trim() && !isProcessing ? 'pointer' : 'not-allowed',
              }}
            >
              שלח
            </button>
          </div>
        </div>
      </div>
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
        bottom: '80px', // Above the navigation bar
        right: '16px',
        width: '56px',
        height: '56px',
        borderRadius: '50%',
        background: 'linear-gradient(135deg, #8B5CF6, #7C3AED)',
        border: 'none',
        boxShadow: '0 4px 12px rgba(139, 92, 246, 0.4)',
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
        e.currentTarget.style.boxShadow = '0 6px 16px rgba(139, 92, 246, 0.5)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'scale(1)';
        e.currentTarget.style.boxShadow = '0 4px 12px rgba(139, 92, 246, 0.4)';
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
