
import React, { useState, useEffect, useRef } from 'react';
import { db } from '../firebase';
import { 
  collection, query, where, getDocs, doc, setDoc, 
  onSnapshot, addDoc, orderBy, updateDoc, writeBatch, increment, deleteDoc, getDoc, arrayUnion, arrayRemove
} from 'firebase/firestore';
import { UserProfile, ChatMetadata, PrivateMessage } from '../types';
import { 
  Search, MessageSquare, ChevronLeft, Send, Lock, 
  ShieldCheck, MoreVertical, Hash, ChevronRight,
  Trash2, Check, CheckCheck, Mic, ArrowRight, X, Loader2,
  Ban, Eraser, UserX
} from 'lucide-react';

interface ChatProps {
  currentUser: UserProfile;
  onJoinRoom: (roomId: string) => void;
}

const simpleEncrypt = (text: string, key: string) => {
  return text.split('').map((c, i) => 
    String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i % key.length))
  ).join('');
};

const simpleDecrypt = (text: string, key: string) => {
  return simpleEncrypt(text, key); 
};

const ENCRYPTION_KEY = "heartly_secret_key"; 

export const Chat: React.FC<ChatProps> = ({ currentUser, onJoinRoom }) => {
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [activeChatUser, setActiveChatUser] = useState<UserProfile | null>(null);
  
  // Search State
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchId, setSearchId] = useState('');
  const [foundUser, setFoundUser] = useState<UserProfile | null>(null);
  const [searchError, setSearchError] = useState('');
  
  // Menu State
  const [showChatMenu, setShowChatMenu] = useState(false);

  const [chats, setChats] = useState<ChatMetadata[]>([]);
  const [messages, setMessages] = useState<PrivateMessage[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [loadingChats, setLoadingChats] = useState(true);
  const [isTyping, setIsTyping] = useState(false);
  const [isOtherUserTyping, setIsOtherUserTyping] = useState(false);
  
  // Long Press & Delete State
  const [longPressedChatId, setLongPressedChatId] = useState<string | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Derived State
  const isBlocked = activeChatUser ? currentUser.blockedUsers?.includes(activeChatUser.uid) : false;

  // Load existing chats
  useEffect(() => {
    const q = query(
      collection(db, 'chats'), 
      where('participants', 'array-contains', currentUser.uid)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const chatList = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as ChatMetadata));
      
      chatList.sort((a, b) => b.updatedAt - a.updatedAt);
      
      setChats(chatList);
      setLoadingChats(false);
    });

    return () => unsubscribe();
  }, [currentUser.uid]);

  // Load messages & Typing Status for active chat
  useEffect(() => {
    if (!activeChatId) return;

    const resetUnread = async () => {
        const chatRef = doc(db, 'chats', activeChatId);
        await updateDoc(chatRef, {
            [`unreadCounts.${currentUser.uid}`]: 0
        }).catch(err => console.log("Init unread count", err));
    };
    resetUnread();

    const q = query(
      collection(db, 'chats', activeChatId, 'messages'),
      orderBy('createdAt', 'asc')
    );

    const unsubscribeMessages = onSnapshot(q, (snapshot) => {
      const msgs: PrivateMessage[] = [];
      const batch = writeBatch(db);
      let needsUpdate = false;

      snapshot.docs.forEach(docSnap => {
        const msg = { id: docSnap.id, ...docSnap.data() } as PrivateMessage;
        msgs.push(msg);

        if (!msg.read && msg.senderId !== currentUser.uid) {
           batch.update(docSnap.ref, { read: true });
           needsUpdate = true;
        }
      });

      if (needsUpdate) {
          batch.commit().catch(console.error);
          updateDoc(doc(db, 'chats', activeChatId), {
            [`unreadCounts.${currentUser.uid}`]: 0
          });
      }

      setMessages(msgs);
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    });

    const chatDocRef = doc(db, 'chats', activeChatId);
    const unsubscribeChat = onSnapshot(chatDocRef, (snapshot) => {
        if (snapshot.exists()) {
            const data = snapshot.data();
            const typingData = data.typing || {};
            const otherUid = activeChatUser?.uid;
            if (otherUid && typingData[otherUid]) {
                setIsOtherUserTyping(true);
                setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
            } else {
                setIsOtherUserTyping(false);
            }
        }
    });

    return () => {
        unsubscribeMessages();
        unsubscribeChat();
    };
  }, [activeChatId, activeChatUser, currentUser.uid]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    setSearchError('');
    setFoundUser(null);

    if (searchId.length !== 4) {
      setSearchError('ID must be 4 characters');
      return;
    }

    try {
      const q = query(collection(db, 'users'), where('uniqueId', '==', searchId.toUpperCase()));
      const snapshot = await getDocs(q);
      
      if (!snapshot.empty) {
        const userData = snapshot.docs[0].data() as UserProfile;
        if (userData.uid === currentUser.uid) {
           setSearchError("You can't chat with yourself!");
        } else {
           setFoundUser(userData);
        }
      } else {
        setSearchError('User not found');
      }
    } catch (err) {
      console.error(err);
      setSearchError('Error searching user');
    }
  };

  const startChat = async (targetUser: UserProfile) => {
    const participants = [currentUser.uid, targetUser.uid].sort();
    const chatId = participants.join('_');

    const chatRef = doc(db, 'chats', chatId);
    const chatSnap = await getDoc(chatRef);

    if (!chatSnap.exists()) {
      await setDoc(chatRef, {
        id: chatId,
        participants: participants,
        participantDetails: [
            { uid: currentUser.uid, displayName: currentUser.displayName, photoURL: currentUser.photoURL },
            { uid: targetUser.uid, displayName: targetUser.displayName, photoURL: targetUser.photoURL }
        ],
        lastMessage: 'Chat started',
        lastMessageTime: Date.now(),
        updatedAt: Date.now(),
        typing: { [currentUser.uid]: false, [targetUser.uid]: false },
        unreadCounts: { [currentUser.uid]: 0, [targetUser.uid]: 0 }
      });
    }

    setActiveChatUser(targetUser);
    setActiveChatId(chatId);
    setSearchId('');
    setFoundUser(null);
    setIsSearchOpen(false);
  };

  const handleTyping = async () => {
      if (!activeChatId) return;

      if (!isTyping) {
          setIsTyping(true);
          await updateDoc(doc(db, 'chats', activeChatId), {
              [`typing.${currentUser.uid}`]: true
          });
      }

      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);

      typingTimeoutRef.current = setTimeout(async () => {
          setIsTyping(false);
          await updateDoc(doc(db, 'chats', activeChatId), {
              [`typing.${currentUser.uid}`]: false
          });
      }, 2000);
  };

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !activeChatId || !activeChatUser) return;

    if (isBlocked) {
        alert("You have blocked this user. Unblock to send messages.");
        return;
    }

    const encryptedText = simpleEncrypt(newMessage.trim(), ENCRYPTION_KEY);
    const recipientId = activeChatUser.uid;

    try {
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      setIsTyping(false);
      
      const chatRef = doc(db, 'chats', activeChatId);

      await addDoc(collection(db, 'chats', activeChatId, 'messages'), {
        text: encryptedText,
        senderId: currentUser.uid,
        createdAt: Date.now(),
        read: false,
        type: 'text'
      });

      await updateDoc(chatRef, {
        [`typing.${currentUser.uid}`]: false,
        lastMessage: 'Encrypted Message',
        lastMessageTime: Date.now(),
        updatedAt: Date.now(),
        [`unreadCounts.${recipientId}`]: increment(1)
      });

      setNewMessage('');
    } catch (err) {
      console.error("Failed to send", err);
    }
  };

  const deleteMessage = async (messageId: string) => {
      if (!activeChatId) return;
      if (window.confirm("Delete this message?")) {
          try {
              await deleteDoc(doc(db, 'chats', activeChatId, 'messages', messageId));
          } catch (e) {
              console.error("Error deleting", e);
          }
      }
  };

  const handleClearChat = async () => {
      if (!activeChatId) return;
      if (messages.length === 0) {
          alert("Chat is already empty.");
          setShowChatMenu(false);
          return;
      }

      if (!window.confirm("Are you sure you want to clear all messages? This cannot be undone.")) return;
      
      setShowChatMenu(false);
      
      try {
          setMessages([]);
          const q = query(collection(db, 'chats', activeChatId, 'messages'));
          const snapshot = await getDocs(q);
          const chunks = [];
          let batch = writeBatch(db);
          let count = 0;
          
          snapshot.docs.forEach((doc) => {
              batch.delete(doc.ref);
              count++;
              if (count === 499) {
                  chunks.push(batch);
                  batch = writeBatch(db);
                  count = 0;
              }
          });
          if (count > 0) chunks.push(batch);
          await Promise.all(chunks.map(b => b.commit()));
          await updateDoc(doc(db, 'chats', activeChatId), {
              lastMessage: 'Chat cleared',
              lastMessageTime: Date.now()
          });
      } catch(e) {
          console.error("Error clearing chat", e);
      }
  };

  const handleBlockUser = async () => {
      if (!activeChatUser) return;
      if (!window.confirm(`Block ${activeChatUser.displayName}?`)) return;
      setShowChatMenu(false);
      try {
          await updateDoc(doc(db, 'users', currentUser.uid), { blockedUsers: arrayUnion(activeChatUser.uid) });
      } catch(e) { console.error(e); }
  };

  const handleUnblockUser = async () => {
      if (!activeChatUser) return;
      if (!window.confirm(`Unblock ${activeChatUser.displayName}?`)) return;
      setShowChatMenu(false);
      try {
          await updateDoc(doc(db, 'users', currentUser.uid), { blockedUsers: arrayRemove(activeChatUser.uid) });
      } catch(e) { console.error(e); }
  };

  const handleDeleteChat = async (chatId: string) => {
      if (!window.confirm("Delete this chat conversation?")) return;
      try {
          await deleteDoc(doc(db, 'chats', chatId));
          setLongPressedChatId(null);
      } catch (e) { console.error(e); }
  };

  const getOtherUser = (chat: ChatMetadata) => {
    return chat.participantDetails.find(p => p.uid !== currentUser.uid) || chat.participantDetails[0];
  };

  if (activeChatId && activeChatUser) {
    return (
      <div className="fixed inset-0 z-[60] flex flex-col bg-[#050505] text-white animate-fade-in">
        <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
            <div className="absolute -top-[10%] -left-[10%] w-64 h-64 bg-violet-600/10 rounded-full blur-[80px]"></div>
            <div className="absolute top-[40%] -right-[10%] w-72 h-72 bg-fuchsia-600/10 rounded-full blur-[100px]"></div>
        </div>

        <div className="absolute top-4 left-4 right-4 z-30">
            <div className="bg-[#121216]/80 backdrop-blur-xl border border-white/10 rounded-2xl px-4 py-3 flex items-center justify-between shadow-2xl">
                <div className="flex items-center gap-3">
                    <button onClick={() => setActiveChatId(null)} className="p-2 -ml-2 text-gray-400 hover:text-white transition-colors rounded-full hover:bg-white/5">
                        <ChevronLeft size={24} />
                    </button>
                    <div className="relative w-10 h-10">
                        <img 
                            src={activeChatUser.photoURL || `https://ui-avatars.com/api/?name=${activeChatUser.displayName}`} 
                            className="w-full h-full rounded-full bg-gray-800 object-cover ring-2 ring-white/10"
                        />
                    </div>
                    <div>
                        <h3 className="font-bold text-sm text-white leading-tight">{activeChatUser.displayName}</h3>
                        <div className="flex items-center gap-1.5 h-4">
                            {isBlocked ? (
                                <span className="text-[10px] text-red-400 font-bold">Blocked</span>
                            ) : isOtherUserTyping ? (
                                <span className="text-[10px] text-fuchsia-400 font-bold animate-pulse">typing...</span>
                            ) : (
                                <>
                                    <ShieldCheck size={10} className="text-emerald-500" />
                                    <span className="text-[10px] text-gray-500 font-medium">Encrypted</span>
                                </>
                            )}
                        </div>
                    </div>
                </div>
                <div className="relative">
                    <button onClick={() => setShowChatMenu(!showChatMenu)} className="p-2 text-gray-500 hover:text-white rounded-full hover:bg-white/5 transition-colors">
                        <MoreVertical size={20} />
                    </button>
                    {showChatMenu && (
                        <div className="absolute right-0 top-full mt-2 w-48 bg-[#1A1A23] border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden animate-fade-in">
                            <button onClick={handleClearChat} className="w-full flex items-center gap-3 px-4 py-3 text-left text-xs font-medium text-gray-300 hover:bg-white/5 hover:text-white transition-colors">
                                <Eraser size={14} /> Clear Chat
                            </button>
                            {isBlocked ? (
                                <button onClick={handleUnblockUser} className="w-full flex items-center gap-3 px-4 py-3 text-left text-xs font-medium text-green-400 hover:bg-green-500/10 transition-colors border-t border-white/5">
                                    <UserX size={14} /> Unblock User
                                </button>
                            ) : (
                                <button onClick={handleBlockUser} className="w-full flex items-center gap-3 px-4 py-3 text-left text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors border-t border-white/5">
                                    <Ban size={14} /> Block User
                                </button>
                            )}
                        </div>
                    )}
                    {showChatMenu && <div className="fixed inset-0 z-40" onClick={() => setShowChatMenu(false)} />}
                </div>
            </div>
        </div>

        <div className="flex-1 overflow-y-auto pt-24 px-4 pb-28 space-y-3 z-10 no-scrollbar">
          {messages.map((msg) => {
            const isMe = msg.senderId === currentUser.uid;
            if (msg.type === 'invite') {
                return (
                    <div key={msg.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                         <div className={`max-w-[75%] w-64 p-1.5 rounded-[1.5rem] relative shadow-2xl ${isMe ? 'bg-gradient-to-br from-violet-600 to-fuchsia-600' : 'bg-[#1A1A23] border border-white/10'}`}>
                             <div className="bg-[#0A0A0E]/90 rounded-[1.2rem] p-4 backdrop-blur-md">
                                <div className="flex items-center gap-3 mb-3">
                                    <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-violet-500 to-fuchsia-500 flex items-center justify-center">
                                        <Mic size={18} className="text-white" />
                                    </div>
                                    <div>
                                        <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest block">Voice Room</span>
                                        <h4 className="text-sm font-bold text-white">{msg.text}</h4>
                                    </div>
                                </div>
                                <button onClick={() => onJoinRoom(msg.roomId!)} className="w-full py-2.5 bg-white text-black text-xs font-bold rounded-xl flex items-center justify-center gap-2">
                                    Join Now <ArrowRight size={14} />
                                </button>
                             </div>
                         </div>
                    </div>
                );
            }
            const decryptedText = simpleDecrypt(msg.text, ENCRYPTION_KEY);
            return (
              <div key={msg.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'} group`}>
                <div className={`max-w-[75%] px-5 py-3 text-sm relative shadow-lg ${isMe ? 'bg-gradient-to-tr from-violet-600 to-fuchsia-600 text-white rounded-[1.2rem] rounded-br-none' : 'bg-[#1A1A23] text-gray-100 border border-white/5 rounded-[1.2rem] rounded-bl-none'}`}>
                  <p className="leading-relaxed break-words font-medium">{decryptedText}</p>
                  <div className="flex items-center justify-end gap-1 mt-1 opacity-70">
                      <p className="text-[9px] font-bold">{new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                      {isMe && (msg.read ? <CheckCheck size={12} className="text-blue-200" /> : <Check size={12} className="text-white/70" />)}
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        <div className="absolute bottom-6 left-4 right-4 z-30">
          {isBlocked ? (
              <div className="bg-[#1A1A23] border border-red-500/20 p-4 rounded-3xl flex justify-between items-center">
                  <span className="text-xs text-red-400 font-bold ml-2">You blocked this user.</span>
                  <button onClick={handleUnblockUser} className="bg-red-500/10 hover:bg-red-500/20 text-red-500 text-xs font-bold px-4 py-2 rounded-xl">Unblock</button>
              </div>
          ) : (
              <form onSubmit={sendMessage} className="flex items-center gap-2 bg-[#121216]/90 backdrop-blur-xl border border-white/10 p-2 rounded-[1.5rem] shadow-2xl">
                <input type="text" value={newMessage} onChange={(e) => { setNewMessage(e.target.value); handleTyping(); }} placeholder="Type message..." className="flex-1 bg-transparent text-white px-4 py-3 outline-none text-sm font-medium" />
                <button type="submit" disabled={!newMessage.trim()} className="p-3 bg-gradient-to-r from-violet-600 to-fuchsia-600 rounded-full text-white disabled:opacity-50">
                  <Send size={18} fill="currentColor" />
                </button>
              </form>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#050505] text-white pb-24 px-6 relative overflow-hidden">
      <div className="absolute top-0 right-0 w-64 h-64 bg-violet-600/10 rounded-full blur-[100px] pointer-events-none"></div>

      <div className="py-8 relative z-10 flex items-center justify-between">
         <div>
             <h1 className="text-4xl font-extrabold bg-clip-text text-transparent bg-gradient-to-br from-white via-violet-200 to-fuchsia-200 tracking-tight">Messages</h1>
             <p className="text-gray-500 text-xs font-bold tracking-widest uppercase mt-2 opacity-60">Your Conversations</p>
         </div>
         <button onClick={() => setIsSearchOpen(!isSearchOpen)} className={`p-3 rounded-2xl transition-all shadow-xl ${isSearchOpen ? 'bg-violet-600 text-white' : 'bg-[#121216] border border-white/10 text-gray-400 hover:text-white'}`}>
             {isSearchOpen ? <X size={20} /> : <Search size={20} />}
         </button>
      </div>

      {isSearchOpen && (
          <div className="mb-6 relative z-20 animate-fade-in">
              <form onSubmit={handleSearch} className="bg-[#121216] border border-white/10 rounded-2xl p-2 flex gap-2">
                  <input type="text" value={searchId} onChange={(e) => setSearchId(e.target.value.toUpperCase())} maxLength={4} placeholder="Enter 4-digit ID..." className="flex-1 bg-transparent px-4 py-2 outline-none text-white font-bold" />
                  <button type="submit" className="px-6 py-2 bg-white text-black font-bold rounded-xl hover:bg-gray-200 transition-colors">Search</button>
              </form>
              {searchError && <p className="text-red-400 text-xs mt-2 ml-2 font-bold">{searchError}</p>}
              {foundUser && (
                  <div onClick={() => startChat(foundUser)} className="mt-3 p-4 bg-white/5 border border-white/10 rounded-2xl flex items-center justify-between hover:bg-white/10 cursor-pointer transition-all animate-fade-in">
                      <div className="flex items-center gap-3">
                          <img src={foundUser.photoURL || ''} className="w-12 h-12 rounded-full bg-gray-800 object-cover" />
                          <div>
                              <p className="font-bold text-white">{foundUser.displayName}</p>
                              <p className="text-xs text-gray-500 font-mono">@{foundUser.uniqueId}</p>
                          </div>
                      </div>
                      <ChevronRight size={20} className="text-gray-600" />
                  </div>
              )}
          </div>
      )}

      <div className="flex-1 overflow-y-auto space-y-3 no-scrollbar pb-10">
        {loadingChats ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3">
                <Loader2 className="animate-spin text-violet-500" size={32} />
                <p className="text-gray-500 text-xs font-bold">Loading chats...</p>
            </div>
        ) : chats.length === 0 ? (
            <div className="text-center py-20 opacity-60">
                <div className="w-20 h-20 bg-white/5 rounded-full flex items-center justify-center mx-auto mb-6">
                    <MessageSquare size={32} className="text-gray-600" />
                </div>
                <p className="text-gray-300 font-bold">No chats yet.</p>
                <p className="text-gray-600 text-xs mt-1">Search an ID to start vibing.</p>
            </div>
        ) : (
          chats.map(chat => {
            const otherUser = getOtherUser(chat);
            const myUnread = chat.unreadCounts?.[currentUser.uid] || 0;
            return (
              <div 
                key={chat.id} 
                onClick={() => { setActiveChatUser(otherUser as any); setActiveChatId(chat.id); }}
                onContextMenu={(e) => { e.preventDefault(); setLongPressedChatId(chat.id); }}
                className="group relative bg-[#121216]/60 backdrop-blur-xl border border-white/5 p-4 rounded-[2rem] flex items-center justify-between hover:border-violet-500/30 transition-all cursor-pointer active:scale-[0.98]"
              >
                <div className="flex items-center gap-4">
                  <div className="relative w-14 h-14">
                      <img src={otherUser?.photoURL || ''} className="w-full h-full rounded-full bg-gray-800 object-cover border-2 border-white/5" />
                      {myUnread > 0 && <div className="absolute -top-1 -right-1 bg-violet-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full border-2 border-[#050505] animate-bounce">{myUnread}</div>}
                  </div>
                  <div>
                    <h4 className="font-bold text-white flex items-center gap-1.5">
                        {otherUser?.displayName}
                        {currentUser.blockedUsers?.includes(otherUser.uid) && <span className="text-[9px] text-red-500 font-bold uppercase">Blocked</span>}
                    </h4>
                    <p className="text-xs text-gray-500 line-clamp-1 w-40 mt-0.5">{chat.lastMessage}</p>
                  </div>
                </div>
                <div className="text-right">
                    <p className="text-[10px] text-gray-600 font-bold">{new Date(chat.lastMessageTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                    <ChevronRight size={16} className="text-gray-700 ml-auto mt-1" />
                </div>
                
                {longPressedChatId === chat.id && (
                    <div className="absolute inset-0 z-50 bg-black/90 backdrop-blur-sm rounded-[2rem] flex items-center justify-center gap-4 animate-fade-in" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => handleDeleteChat(chat.id)} className="p-4 bg-red-500 text-white rounded-2xl flex flex-col items-center gap-2 font-bold text-xs"><Trash2 size={24} /> Delete Chat</button>
                        <button onClick={() => setLongPressedChatId(null)} className="p-4 bg-white/10 text-white rounded-2xl flex flex-col items-center gap-2 font-bold text-xs"><X size={24} /> Cancel</button>
                    </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
