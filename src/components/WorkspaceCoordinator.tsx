import React, { useState, useEffect, useCallback } from 'react';
import {
  CheckSquare, Mail, FileText, FileSpreadsheet, Plus, Trash, RefreshCw, Send, ListTodo,
  UserPlus, Calendar, AlertCircle, CheckCircle, Loader2, Sparkles,
  ExternalLink, Bookmark, UserCheck, Lock, Archive, Shield
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import {
  runSql,
  syncAllAccountingSystems,
  persistTablesToStorage,
  getCustomPaymentMethods,
  resolvePaymentMethodBucket,
  getActiveBusinessId,
  getActiveStoreId,
  sqlEsc,
  ensureWorkspaceTables,
  logEmployeeAudit,
} from '../db';
import { CustomPaymentMethod } from '../types';
import { auth, googleSignIn, googleSignOut, getAccessToken, syncSaleToFirestoreOfflineSafe } from '../firebase';
import { User as FirebaseUser } from 'firebase/auth';

interface WorkspaceCoordinatorProps {
  userRole: string;
  activeStore: string;
}

interface StaffMember {
  id: string;
  first_name: string;
  surname: string;
  email: string;
  role?: string;
}

interface PosTask {
  id: string;
  title: string;
  description: string;
  assigneeId: string;
  assigneeName: string;
  assigneeEmail: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  due?: string;
  status: 'completed' | 'needsAction';
  archived: boolean;
  completed?: string;
  googleTaskId?: string;
  createdBy?: string;
  createdAt?: string;
  source: 'local' | 'google';
}

interface KeepNote {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
  color?: string;
  googleTaskId?: string;
}

interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  subject?: string;
  from?: string;
  date?: string;
}

interface FormDetail {
  id: string;
  title: string;
  description?: string;
  responsesCount?: number;
}

interface ConfirmDialogState {
  title: string;
  message: string;
  confirmLabel: string;
  tone: 'indigo' | 'emerald' | 'rose';
  onConfirm: () => Promise<void> | void;
}

export default function WorkspaceCoordinator({ userRole, activeStore }: WorkspaceCoordinatorProps) {
  // Session States (Google OAuth is optional for Tasks/Notes, required only for Gmail/Docs/Forms/Google Cloud sync)
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  // General tab switcher
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<'tasks' | 'keep' | 'gmail' | 'docs_forms'>('tasks');

  // Business / Staff states
  const [staffList, setStaffList] = useState<StaffMember[]>([]);

  // Task Coordinator States
  const [tasks, setTasks] = useState<PosTask[]>([]);
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [taskFilter, setTaskFilter] = useState<'all' | 'pending' | 'completed' | 'assigned_to_me' | 'archived'>('all');

  // Create Task Form States
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDesc, setNewTaskDesc] = useState('');
  const [newTaskDue, setNewTaskDue] = useState('');
  const [newTaskAssignee, setNewTaskAssignee] = useState<string>('general');
  const [newTaskPriority, setNewTaskPriority] = useState<'LOW' | 'MEDIUM' | 'HIGH'>('MEDIUM');
  const [isCreatingTask, setIsCreatingTask] = useState(false);

  // Gmail states
  const [messages, setMessages] = useState<GmailMessage[]>([]);
  const [isLoadingGmail, setIsLoadingGmail] = useState(false);
  const [gmailError, setGmailError] = useState<string | null>(null);
  const [emailTo, setEmailTo] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [isSendingEmail, setIsSendingEmail] = useState(false);

  // Keep Notes states
  const [keepNotes, setKeepNotes] = useState<KeepNote[]>([]);
  const [isLoadingKeep, setIsLoadingKeep] = useState(false);
  const [keepError, setKeepError] = useState<string | null>(null);
  const [newNoteTitle, setNewNoteTitle] = useState('');
  const [newNoteContent, setNewNoteContent] = useState('');
  const [newNoteColor, setNewNoteColor] = useState('bg-white');

  // Google Docs / Forms integration states
  const [isCompilingDoc, setIsCompilingDoc] = useState(false);
  const [compiledDocId, setCompiledDocId] = useState<string | null>(null);
  const [docCompileTemplate, setDocCompileTemplate] = useState<'summary' | 'blank' | 'transfer'>('summary');
  const [customFormId, setCustomFormId] = useState('');
  const [formDetail, setFormDetail] = useState<FormDetail | null>(null);
  const [isFetchingForm, setIsFetchingForm] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Recording Task to Financials States
  const [showFinancialsModal, setShowFinancialsModal] = useState(false);
  const [selectedTaskForFinancials, setSelectedTaskForFinancials] = useState<PosTask | null>(null);
  const [financialsServices, setFinancialsServices] = useState<any[]>([]);
  const [selectedServiceId, setSelectedServiceId] = useState<string>('');
  const [paymentMethod, setPaymentMethod] = useState<string>('Cash');
  const [customMethods, setCustomMethods] = useState<CustomPaymentMethod[]>(() => getCustomPaymentMethods(false));
  const [customerList, setCustomerList] = useState<any[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');

  // In-UI Confirmation & Feedback Banner
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [isConfirmBusy, setIsConfirmBusy] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<{ status: 'success' | 'info' | 'error'; text: string } | null>(null);

  const triggerFeedback = (text: string, status: 'success' | 'info' | 'error' = 'info') => {
    setFeedbackMsg({ status, text });
    setTimeout(() => {
      setFeedbackMsg((prev) => (prev?.text === text ? null : prev));
    }, 5000);
  };

  // Helper parser for Google Task structured description
  const parseTaskNotes = (notesText: string | undefined) => {
    if (!notesText) {
      return { assigneeId: 'general', assigneeName: 'All Store Staff', priority: 'MEDIUM' as const, description: '', archived: false };
    }
    const idMatch = notesText.match(/\[ASSIGNEE_ID:\s*([^\]]+)\]/);
    const nameMatch = notesText.match(/\[ASSIGNEE_NAME:\s*([^\]]+)\]/);
    const priorityMatch = notesText.match(/\[PRIORITY:\s*([^\]]+)\]/);
    const archivedMatch = notesText.match(/\[ARCHIVED:\s*([^\]]+)\]/);

    const cleanDesc = notesText
      .replace(/\[ASSIGNEE_ID:[^\]]+\]/g, '')
      .replace(/\[ASSIGNEE_NAME:[^\]]+\]/g, '')
      .replace(/\[PRIORITY:[^\]]+\]/g, '')
      .replace(/\[ARCHIVED:[^\]]+\]/g, '')
      .trim();

    const parsedPriority = (priorityMatch ? priorityMatch[1].trim().toUpperCase() : 'MEDIUM') as 'LOW' | 'MEDIUM' | 'HIGH';
    return {
      assigneeId: idMatch ? idMatch[1].trim() : 'general',
      assigneeName: nameMatch ? nameMatch[1].trim() : 'All Store Staff',
      priority: (['LOW', 'MEDIUM', 'HIGH'].includes(parsedPriority) ? parsedPriority : 'MEDIUM') as 'LOW' | 'MEDIUM' | 'HIGH',
      description: cleanDesc,
      archived: archivedMatch ? archivedMatch[1].trim() === 'true' : false,
    };
  };

  const serializeTaskNotes = (parsed: {
    assigneeId: string;
    assigneeName: string;
    priority: string;
    description: string;
    archived: boolean;
  }) => {
    const parts = [
      `[ASSIGNEE_ID: ${parsed.assigneeId}]`,
      `[ASSIGNEE_NAME: ${parsed.assigneeName}]`,
      `[PRIORITY: ${parsed.priority}]`,
    ];
    if (parsed.archived) {
      parts.push('[ARCHIVED: true]');
    }
    if (parsed.description) {
      parts.push(parsed.description);
    }
    return parts.join(' ');
  };

  const fetchStaffFromDb = useCallback(() => {
    try {
      const activeBizId = getActiveBusinessId();
      const bizWhere = activeBizId ? `WHERE business_id = '${sqlEsc(activeBizId)}'` : '';
      const bizAnd = activeBizId ? `AND business_id = '${sqlEsc(activeBizId)}'` : '';

      const mergedStaff = new Map<string, StaffMember>();

      const res = runSql(
        `SELECT id, name, first_name, surname, email, role FROM staff ${bizWhere}`,
        'Fetch staff list for task coordinator',
        true
      );
      if (res.success && Array.isArray(res.data)) {
        res.data.forEach((row: any) => {
          const idStr = String(row.id || '').trim();
          if (!idStr) return;
          const fName = String(row.first_name || '').trim();
          const sName = String(row.surname || '').trim();
          const fallbackName = String(row.name || '').trim();
          const firstName = fName || (fallbackName ? fallbackName.split(/\s+/)[0] : 'Staff');
          const surname = sName || (fallbackName ? fallbackName.split(/\s+/).slice(1).join(' ') : '');
          mergedStaff.set(idStr, {
            id: idStr,
            first_name: firstName,
            surname,
            email: String(row.email || '').trim(),
            role: String(row.role || 'staff'),
          });
        });
      }

      // Also include active business_memberships so managers/cashiers without separate staff rows can be assigned
      const memRes = runSql(
        `SELECT user_id, id, full_name, email, role FROM business_memberships ${bizWhere}`,
        'Fetch business memberships for task coordinator',
        true
      );
      if (memRes.success && Array.isArray(memRes.data)) {
        memRes.data.forEach((m: any) => {
          const email = String(m.email || '').trim().toLowerCase();
          const alreadyByEmail = Array.from(mergedStaff.values()).some(
            (s) => email && s.email.toLowerCase() === email
          );
          if (alreadyByEmail) return;
          const idStr = String(m.user_id || m.id || '').trim();
          if (!idStr || mergedStaff.has(idStr)) return;
          const full = String(m.full_name || email || 'Team Member').trim();
          const parts = full.split(/\s+/);
          mergedStaff.set(idStr, {
            id: idStr,
            first_name: parts[0] || full,
            surname: parts.slice(1).join(' '),
            email: String(m.email || '').trim(),
            role: String(m.role || 'staff'),
          });
        });
      }

      setStaffList(Array.from(mergedStaff.values()));

      // Fetch corporate services (is_service = 1)
      const serviceRes = runSql(
        `SELECT id, name, price, cost FROM products WHERE is_service = 1 ${bizAnd}`,
        'Fetch services for financial recording',
        true
      );
      if (serviceRes.success && Array.isArray(serviceRes.data)) {
        setFinancialsServices(serviceRes.data);
        if (serviceRes.data.length > 0 && !selectedServiceId) {
          setSelectedServiceId(serviceRes.data[0].id.toString());
        }
      }

      // Fetch customers
      const custRes = runSql(
        `SELECT id, name FROM customers ${bizWhere}`,
        'Fetch customers for task financials',
        true
      );
      if (custRes.success && Array.isArray(custRes.data)) {
        setCustomerList(custRes.data);
      }
    } catch (e) {
      console.error(e);
    }
  }, [selectedServiceId]);

  const loadLocalTasks = useCallback((): PosTask[] => {
    ensureWorkspaceTables();
    const activeBizId = getActiveBusinessId();
    const bizWhere = activeBizId ? `WHERE business_id = '${sqlEsc(activeBizId)}'` : '';
    const res = runSql(
      `SELECT * FROM business_tasks ${bizWhere} ORDER BY created_at DESC`,
      'Fetch POS business tasks',
      true
    );
    if (!res.success || !Array.isArray(res.data)) {
      setTasks([]);
      return [];
    }
    const mapped: PosTask[] = res.data.map((r: any) => ({
      id: String(r.id),
      title: String(r.title || ''),
      description: String(r.description || ''),
      assigneeId: String(r.assignee_id || 'general'),
      assigneeName: String(r.assignee_name || 'All Store Staff'),
      assigneeEmail: String(r.assignee_email || ''),
      priority: (['LOW', 'MEDIUM', 'HIGH'].includes(String(r.priority || '').toUpperCase())
        ? String(r.priority).toUpperCase()
        : 'MEDIUM') as 'LOW' | 'MEDIUM' | 'HIGH',
      due: r.due_date ? String(r.due_date) : undefined,
      status: r.status === 'completed' ? 'completed' : 'needsAction',
      archived: Number(r.archived) === 1 || r.archived === true,
      completed: r.completed_at ? String(r.completed_at) : undefined,
      googleTaskId: r.google_task_id ? String(r.google_task_id) : undefined,
      createdBy: r.created_by ? String(r.created_by) : undefined,
      createdAt: r.created_at ? String(r.created_at) : undefined,
      source: 'local',
    }));
    setTasks(mapped);
    return mapped;
  }, []);

  const loadLocalKeepNotes = useCallback((): KeepNote[] => {
    ensureWorkspaceTables();
    const activeBizId = getActiveBusinessId();
    const bizWhere = activeBizId ? `WHERE business_id = '${sqlEsc(activeBizId)}'` : '';
    const res = runSql(
      `SELECT * FROM workspace_notes ${bizWhere} ORDER BY updated_at DESC`,
      'Fetch POS workspace notes',
      true
    );
    if (!res.success || !Array.isArray(res.data)) {
      setKeepNotes([]);
      return [];
    }
    const mapped: KeepNote[] = res.data.map((n: any) => ({
      id: String(n.id),
      title: String(n.title || 'Untitled Note'),
      content: String(n.content || ''),
      updatedAt: String(n.updated_at || new Date().toISOString()),
      color: String(n.color || 'bg-white'),
      googleTaskId: n.google_task_id ? String(n.google_task_id) : undefined,
    }));
    setKeepNotes(mapped);
    return mapped;
  }, []);

  // Sync session state and POS data on mount + listen for live DB updates
  useEffect(() => {
    ensureWorkspaceTables();
    const checkLoggedSession = async () => {
      try {
        const u = auth.currentUser;
        if (u) {
          setUser(u);
        }
        const token = await getAccessToken();
        if (token) {
          setAccessToken(token);
        }
      } catch (err) {
        console.error('Session seek error: ', err);
      }
    };
    checkLoggedSession();
    fetchStaffFromDb();
    loadLocalTasks();
    loadLocalKeepNotes();

    const syncAll = () => {
      setCustomMethods(getCustomPaymentMethods(false));
      fetchStaffFromDb();
      loadLocalTasks();
      loadLocalKeepNotes();
    };
    window.addEventListener('pos_data_updated', syncAll);
    window.addEventListener('local_db_restored', syncAll);
    return () => {
      window.removeEventListener('pos_data_updated', syncAll);
      window.removeEventListener('local_db_restored', syncAll);
    };
  }, [fetchStaffFromDb, loadLocalTasks, loadLocalKeepNotes]);

  // ==========================================
  // GOOGLE TASKS + LOCAL POS TASKS HANDLERS
  // ==========================================
  const fetchGoogleTasks = useCallback(async () => {
    const localRows = loadLocalTasks();
    if (!accessToken) {
      setTaskError(null);
      return;
    }

    setIsLoadingTasks(true);
    setTaskError(null);
    try {
      const res = await fetch(
        'https://www.googleapis.com/tasks/v1/lists/@default/tasks?showCompleted=true&showHidden=true',
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!res.ok) {
        throw new Error(`Tasks API responded with status [${res.status}]`);
      }
      const data = await res.json();
      const rawTasks: any[] = data.items || [];

      const localGoogleIds = new Set(localRows.map((t) => t.googleTaskId).filter(Boolean));
      const remoteOnly: PosTask[] = rawTasks
        .filter((gt) => !localGoogleIds.has(String(gt.id)))
        .map((gt) => {
          const parsed = parseTaskNotes(gt.notes);
          return {
            id: `GT-${gt.id}`,
            googleTaskId: String(gt.id),
            title: String(gt.title || 'Untitled Task'),
            description: parsed.description,
            assigneeId: parsed.assigneeId,
            assigneeName: parsed.assigneeName,
            assigneeEmail: '',
            priority: parsed.priority,
            due: gt.due ? String(gt.due) : undefined,
            status: gt.status === 'completed' ? 'completed' : 'needsAction',
            archived: parsed.archived,
            completed: gt.completed ? String(gt.completed) : undefined,
            source: 'google',
          };
        });

      setTasks([...localRows, ...remoteOnly]);
    } catch (err: any) {
      console.error(err);
      setTaskError(err?.message || 'Google Tasks cloud sync failed — showing saved POS directives.');
      setTasks(localRows);
    } finally {
      setIsLoadingTasks(false);
    }
  }, [accessToken, loadLocalTasks]);

  const fetchGmailMessages = useCallback(async () => {
    if (!accessToken) return;
    setIsLoadingGmail(true);
    setGmailError(null);
    try {
      const res = await fetch('https://www.googleapis.com/gmail/v1/users/me/messages?maxResults=8', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`Gmail API returned status code [${res.status}]`);
      const data = await res.json();
      const partialMsgs: { id: string; threadId: string }[] = data.messages || [];

      const fullMessages = await Promise.all(
        partialMsgs.map(async (m) => {
          const detailRes = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${m.id}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (!detailRes.ok) return { id: m.id, threadId: m.threadId, snippet: 'No detailed preview available.' };
          const detailData = await detailRes.json();

          const headers: any[] = detailData.payload?.headers || [];
          const subjectHeader = headers.find((h) => h.name.toLowerCase() === 'subject');
          const fromHeader = headers.find((h) => h.name.toLowerCase() === 'from');
          const dateHeader = headers.find((h) => h.name.toLowerCase() === 'date');

          return {
            id: m.id,
            threadId: m.threadId,
            snippet: detailData.snippet || '',
            subject: subjectHeader ? subjectHeader.value : 'No Subject',
            from: fromHeader ? fromHeader.value : 'Unknown Sender',
            date: dateHeader ? dateHeader.value : '',
          };
        })
      );
      setMessages(fullMessages);
    } catch (err: any) {
      console.error(err);
      setGmailError(err?.message || 'Failed to sync Gmail records.');
    } finally {
      setIsLoadingGmail(false);
    }
  }, [accessToken]);

  const fetchKeepNotes = useCallback(async () => {
    const localNotes = loadLocalKeepNotes();
    if (!accessToken) {
      setKeepError(null);
      return;
    }

    setIsLoadingKeep(true);
    setKeepError(null);
    try {
      const listRes = await fetch('https://www.googleapis.com/tasks/v1/users/@me/lists', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!listRes.ok) throw new Error(`Google Lists returned [${listRes.status}]`);
      const listData = await listRes.json();
      const lists: any[] = listData.items || [];

      let keepListId = '@default';
      const foundKeepList = lists.find((l) => l.title === 'Shop Keep Notes');
      if (foundKeepList) {
        keepListId = foundKeepList.id;
      } else {
        const createListRes = await fetch('https://www.googleapis.com/tasks/v1/users/@me/lists', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title: 'Shop Keep Notes' }),
        });
        if (createListRes.ok) {
          const newList = await createListRes.json();
          keepListId = newList.id;
        }
      }

      const notesRes = await fetch(`https://www.googleapis.com/tasks/v1/lists/${keepListId}/tasks?showCompleted=false`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const notesData = await notesRes.json();
      const rawNotes: any[] = notesData.items || [];

      const localGoogleIds = new Set(localNotes.map((n) => n.googleTaskId).filter(Boolean));
      const mappedRemote: KeepNote[] = rawNotes
        .filter((n) => !localGoogleIds.has(String(n.id)))
        .map((n) => {
          const notesBody = n.notes || '';
          const colorMatch = notesBody.match(/\[COLOR:\s*([^\]]+)\]/);
          const cleanContent = notesBody.replace(/\[COLOR:[^\]]+\]/, '').trim();

          return {
            id: `GN-${n.id}`,
            googleTaskId: String(n.id),
            title: n.title || 'Untitled Note',
            content: cleanContent || 'No description.',
            updatedAt: n.updated || new Date().toISOString(),
            color: colorMatch ? colorMatch[1] : 'bg-white',
          };
        });

      setKeepNotes([...localNotes, ...mappedRemote]);
    } catch (err: any) {
      console.error(err);
      setKeepError(err?.message || 'Google Keep cloud sync unavailable — showing local shop notes.');
      setKeepNotes(localNotes);
    } finally {
      setIsLoadingKeep(false);
    }
  }, [accessToken, loadLocalKeepNotes]);

  // Sync workspace operations when tab or token changes
  useEffect(() => {
    if (activeWorkspaceTab === 'tasks') {
      fetchGoogleTasks();
    } else if (activeWorkspaceTab === 'keep') {
      fetchKeepNotes();
    } else if (activeWorkspaceTab === 'gmail' && accessToken) {
      fetchGmailMessages();
    }
  }, [accessToken, activeWorkspaceTab, fetchGoogleTasks, fetchKeepNotes, fetchGmailMessages]);

  const handleSignIn = async () => {
    setIsLoggingIn(true);
    setTaskError(null);
    try {
      const res = await googleSignIn();
      if (res) {
        setUser(res.user);
        setAccessToken(res.accessToken);
        triggerFeedback('Connected to Google Workspace successfully!', 'success');
      }
    } catch (err: any) {
      console.error(err);
      triggerFeedback(err?.message || 'Google authentication failed', 'error');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await googleSignOut();
      setUser(null);
      setAccessToken(null);
      setMessages([]);
      loadLocalTasks();
      loadLocalKeepNotes();
      triggerFeedback('Disconnected from Google Workspace.', 'info');
    } catch (err: any) {
      console.error(err);
    }
  };

  // Create & Assign Task (Persists to POS business_tasks + Cloud Firestore, and optionally Google Tasks)
  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (userRole === 'sales') {
      triggerFeedback('Access Denied: Only Owners or Store Managers can assign directives.', 'error');
      return;
    }

    const cleanTitle = newTaskTitle.trim();
    if (!cleanTitle) {
      triggerFeedback('Task instruction / title is required.', 'error');
      return;
    }

    setIsCreatingTask(true);
    try {
      ensureWorkspaceTables();
      const activeBizId = getActiveBusinessId();
      const resolvedStoreId = getActiveStoreId(activeStore, activeBizId);
      const nowIso = new Date().toISOString();

      const assignedUser =
        newTaskAssignee && newTaskAssignee !== 'general'
          ? staffList.find((s) => String(s.id) === String(newTaskAssignee))
          : undefined;
      const assigneeId = assignedUser ? String(assignedUser.id) : 'general';
      const assigneeName = assignedUser
        ? `${assignedUser.first_name} ${assignedUser.surname}`.trim()
        : 'All Store Staff';
      const assigneeEmail = assignedUser ? assignedUser.email : '';
      const createdBy =
        (typeof localStorage !== 'undefined' &&
          (localStorage.getItem('logged_in_user_name') || localStorage.getItem('logged_in_user_email'))) ||
        user?.displayName ||
        userRole;

      const taskId = `TASK-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const dueIso = newTaskDue ? `${newTaskDue}T12:00:00Z` : '';

      let googleTaskId = '';
      let googleSyncNote = '';

      if (accessToken) {
        try {
          const formattedNotes = serializeTaskNotes({
            assigneeId,
            assigneeName,
            priority: newTaskPriority,
            description: newTaskDesc.trim(),
            archived: false,
          });
          const gBody: any = { title: cleanTitle, notes: formattedNotes };
          if (dueIso) gBody.due = dueIso;

          const gRes = await fetch('https://www.googleapis.com/tasks/v1/lists/@default/tasks', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(gBody),
          });
          if (gRes.ok) {
            const createdGoogle = await gRes.json();
            googleTaskId = String(createdGoogle.id || '');
          } else {
            googleSyncNote = ' (Saved to POS; Google Tasks token expired)';
          }
        } catch {
          googleSyncNote = ' (Saved to POS; Google Tasks offline)';
        }
      }

      const insertRes = runSql(
        `INSERT INTO business_tasks (
          id, title, description, assignee_id, assignee_name, assignee_email,
          priority, due_date, status, archived, google_task_id, created_by,
          created_at, updated_at, completed_at, business_id, store_id
        ) VALUES (
          '${sqlEsc(taskId)}',
          '${sqlEsc(cleanTitle)}',
          '${sqlEsc(newTaskDesc.trim())}',
          '${sqlEsc(assigneeId)}',
          '${sqlEsc(assigneeName)}',
          '${sqlEsc(assigneeEmail)}',
          '${sqlEsc(newTaskPriority)}',
          '${sqlEsc(dueIso)}',
          'needsAction',
          0,
          '${sqlEsc(googleTaskId)}',
          '${sqlEsc(createdBy)}',
          '${nowIso}',
          '${nowIso}',
          '',
          '${sqlEsc(activeBizId)}',
          '${sqlEsc(resolvedStoreId)}'
        )`,
        `Direct & Assign Task: ${cleanTitle} -> ${assigneeName}`
      );

      if (!insertRes.success) {
        throw new Error(insertRes.error || 'Could not save task into POS database.');
      }

      logEmployeeAudit(
        'FINANCE',
        'Assigned Staff Task Directive',
        `"${cleanTitle}" assigned to ${assigneeName} (Priority: ${newTaskPriority}${newTaskDue ? `, Due: ${newTaskDue}` : ''})`,
        0,
        resolvedStoreId,
        createdBy
      );

      persistTablesToStorage();
      try {
        window.dispatchEvent(new Event('pos_data_updated'));
      } catch {}

      setNewTaskTitle('');
      setNewTaskDesc('');
      setNewTaskDue('');
      setNewTaskAssignee('general');
      setNewTaskPriority('MEDIUM');

      await fetchGoogleTasks();
      triggerFeedback(`✓ Task directed & assigned to ${assigneeName}!${googleSyncNote}`, 'success');
    } catch (err: any) {
      console.error(err);
      triggerFeedback(err?.message || 'Failed to create and assign task.', 'error');
    } finally {
      setIsCreatingTask(false);
    }
  };

  // Toggle complete / needsAction status (In-UI confirmation, no window.confirm)
  const handleToggleTaskStatus = (task: PosTask) => {
    const nextStatus = task.status === 'completed' ? 'needsAction' : 'completed';
    const statusLabel = nextStatus === 'completed' ? 'COMPLETED' : 'PENDING';

    setConfirmDialog({
      title: nextStatus === 'completed' ? 'Mark Directive Completed?' : 'Reopen Directive as Pending?',
      message: `Update "${task.title}" status to ${statusLabel}?`,
      confirmLabel: nextStatus === 'completed' ? 'Mark Completed' : 'Reopen Task',
      tone: nextStatus === 'completed' ? 'emerald' : 'indigo',
      onConfirm: async () => {
        const nowIso = new Date().toISOString();
        const completedAt = nextStatus === 'completed' ? nowIso : '';
        const activeBizId = getActiveBusinessId();
        const bizCond = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';

        if (task.source === 'local') {
          runSql(
            `UPDATE business_tasks SET status = '${nextStatus}', completed_at = '${sqlEsc(completedAt)}', updated_at = '${nowIso}' WHERE id = '${sqlEsc(task.id)}'${bizCond}`,
            `Task Status -> ${statusLabel}: ${task.title}`
          );
          persistTablesToStorage();
          try {
            window.dispatchEvent(new Event('pos_data_updated'));
          } catch {}
        }

        if (accessToken && task.googleTaskId) {
          try {
            const updateBody: any = {
              id: task.googleTaskId,
              status: nextStatus,
              completed: nextStatus === 'completed' ? nowIso : null,
            };
            await fetch(`https://www.googleapis.com/tasks/v1/lists/@default/tasks/${task.googleTaskId}`, {
              method: 'PUT',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(updateBody),
            });
          } catch (err) {
            console.warn('Google Tasks status sync skipped:', err);
          }
        }

        await fetchGoogleTasks();
        triggerFeedback(`Task "${task.title}" marked ${statusLabel.toLowerCase()}.`, 'success');
      },
    });
  };

  const handleDeleteTask = (task: PosTask) => {
    setConfirmDialog({
      title: 'Delete Directive Permanently?',
      message: `Are you sure you want to remove "${task.title}"? This action cannot be undone.`,
      confirmLabel: 'Delete Task',
      tone: 'rose',
      onConfirm: async () => {
        const activeBizId = getActiveBusinessId();
        const bizCond = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';

        if (task.source === 'local') {
          runSql(
            `DELETE FROM business_tasks WHERE id = '${sqlEsc(task.id)}'${bizCond}`,
            `Delete POS Task: ${task.title}`
          );
          persistTablesToStorage();
          try {
            window.dispatchEvent(new Event('pos_data_updated'));
          } catch {}
        }

        if (accessToken && task.googleTaskId) {
          try {
            await fetch(`https://www.googleapis.com/tasks/v1/lists/@default/tasks/${task.googleTaskId}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${accessToken}` },
            });
          } catch (err) {
            console.warn('Google Tasks delete sync skipped:', err);
          }
        }

        await fetchGoogleTasks();
        triggerFeedback('Task deleted successfully.', 'success');
      },
    });
  };

  const handleArchiveTask = (task: PosTask, archiveState: boolean) => {
    const actionText = archiveState ? 'archive' : 'unarchive';
    setConfirmDialog({
      title: archiveState ? 'Archive Completed Task?' : 'Restore Archived Task?',
      message: `Are you sure you want to ${actionText} "${task.title}"?`,
      confirmLabel: archiveState ? 'Archive Task' : 'Unarchive Task',
      tone: 'indigo',
      onConfirm: async () => {
        const nowIso = new Date().toISOString();
        const activeBizId = getActiveBusinessId();
        const bizCond = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';

        if (task.source === 'local') {
          runSql(
            `UPDATE business_tasks SET archived = ${archiveState ? 1 : 0}, updated_at = '${nowIso}' WHERE id = '${sqlEsc(task.id)}'${bizCond}`,
            `${archiveState ? 'Archive' : 'Unarchive'} Task: ${task.title}`
          );
          persistTablesToStorage();
          try {
            window.dispatchEvent(new Event('pos_data_updated'));
          } catch {}
        }

        if (accessToken && task.googleTaskId) {
          try {
            const updatedNotes = serializeTaskNotes({
              assigneeId: task.assigneeId,
              assigneeName: task.assigneeName,
              priority: task.priority,
              description: task.description,
              archived: archiveState,
            });
            await fetch(`https://www.googleapis.com/tasks/v1/lists/@default/tasks/${task.googleTaskId}`, {
              method: 'PUT',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                id: task.googleTaskId,
                title: task.title,
                notes: updatedNotes,
                status: task.status,
              }),
            });
          } catch (err) {
            console.warn('Google Tasks archive sync skipped:', err);
          }
        }

        await fetchGoogleTasks();
        triggerFeedback(`Task successfully ${archiveState ? 'archived' : 'unarchived'}.`, 'success');
      },
    });
  };

  const handleInitFinancialRecord = (task: PosTask) => {
    if (financialsServices.length === 0) {
      triggerFeedback(
        'No company services have been registered yet in Inventory! Please register a service (is_service) under Inventory first.',
        'error'
      );
      return;
    }
    setSelectedTaskForFinancials(task);
    setShowFinancialsModal(true);
  };

  const handleRecordFinancials = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTaskForFinancials) return;

    const serviceObj = financialsServices.find((s) => s.id.toString() === selectedServiceId);
    if (!serviceObj) {
      triggerFeedback('Selected service not found.', 'error');
      return;
    }

    const orderId = 'ord_task_' + Math.floor(100000 + Math.random() * 900000);
    const dateStr = new Date().toISOString();
    const customerIdVal = selectedCustomerId ? Number(selectedCustomerId) : 'NULL';

    const subtotal = Number(serviceObj.price || 0);
    const taxAmount = subtotal * 0.16;
    const discountAmount = 0;
    const totalAmount = subtotal + taxAmount;

    const activeBizId = getActiveBusinessId();
    const resolvedStoreId = getActiveStoreId(activeStore, activeBizId);

    const orderInsertSql = `
      INSERT INTO orders (id, customerId, orderDate, subtotal, tax, discount, total, paymentMethod, status, store_id, performed_by, business_id) VALUES (
        '${orderId}', 
        ${customerIdVal}, 
        '${dateStr}', 
        ${subtotal.toFixed(2)}, 
        ${taxAmount.toFixed(2)}, 
        ${discountAmount.toFixed(2)}, 
        ${totalAmount.toFixed(2)}, 
        '${sqlEsc(paymentMethod)}', 
        'Completed',
        '${sqlEsc(resolvedStoreId)}',
        '${(localStorage.getItem('logged_in_user_name') || 'Task Operator').replace(/'/g, "''")}',
        '${sqlEsc(activeBizId)}'
      )
    `;
    const resOrder = runSql(
      orderInsertSql,
      `Billing: Record completed task financials for task ${selectedTaskForFinancials.title}`
    );
    if (!resOrder.success) {
      triggerFeedback('Error saving transaction to financials database: ' + resOrder.error, 'error');
      return;
    }

    const orderItemId = `${orderId}_1`;
    const itemInsertSql = `
      INSERT INTO order_items (id, orderId, productId, quantity, unitPrice, business_id, store_id) VALUES (
        '${orderItemId}', 
        '${orderId}', 
        ${serviceObj.id}, 
        1, 
        ${serviceObj.price},
        '${sqlEsc(activeBizId)}',
        '${sqlEsc(resolvedStoreId)}'
      )
    `;
    runSql(itemInsertSql, `Billing: Post sales line item for service #${serviceObj.name}`);

    const txId = `tx_${orderId.toLowerCase()}_${Math.floor(100 + Math.random() * 900)}`;
    const idempotencyKey = `idemp_${txId}`;
    const calculatedFeeRate = paymentMethod === 'Cash' ? 0.0 : 0.015;
    const feeAmount = parseFloat((totalAmount * calculatedFeeRate).toFixed(4));
    const netSettlement = totalAmount - feeAmount;

    const resolvedPay = resolvePaymentMethodBucket(paymentMethod);
    const clearingAccountId = resolvedPay.clearingAccountId;
    let channel = 'CASH';

    if (paymentMethod === 'Airtel Money') {
      channel = 'AIRTEL_MONEY';
    } else if (paymentMethod === 'MTN Mobile Money') {
      channel = 'MTN_MOMO';
    } else if (paymentMethod === 'Credit Card') {
      channel = 'CARD_VISA';
    } else if (paymentMethod !== 'Cash') {
      channel = `CUSTOM_${paymentMethod.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    }

    runSql(
      `
      INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at, updated_at, business_id, store_id)
      VALUES ('${txId}', '${idempotencyKey}', 'POS-${sqlEsc(resolvedStoreId.toUpperCase())}-01', '${channel}', 'POS-REF-${orderId}', ${totalAmount.toFixed(4)}, ${feeAmount.toFixed(4)}, 'SUCCESS', 'Completed Company Task service Checkout #${orderId}', '${dateStr}', '${dateStr}', '${sqlEsc(activeBizId)}', '${sqlEsc(resolvedStoreId)}')
    `,
      'Double Entry: Journal completion of task service'
    );

    runSql(
      `
      INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at, business_id, store_id)
      VALUES ('le_${txId}_deb', '${txId}', '${clearingAccountId}', 'DEBIT', ${totalAmount.toFixed(4)}, '${dateStr}', '${sqlEsc(activeBizId)}', '${sqlEsc(resolvedStoreId)}')
    `,
      'Double Entry: Debit Clearing account'
    );

    runSql(
      `
      INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at, business_id, store_id)
      VALUES ('le_${txId}_cre_merch', '${txId}', 'merchant-wallet-account-uuid', 'CREDIT', ${netSettlement.toFixed(4)}, '${dateStr}', '${sqlEsc(activeBizId)}', '${sqlEsc(resolvedStoreId)}')
    `,
      'Double Entry: Credit Wallet'
    );

    if (feeAmount > 0) {
      runSql(
        `
        INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at, business_id, store_id)
        VALUES ('le_${txId}_cre_fee', '${txId}', 'zra-tax-payment-escrow-uuid', 'CREDIT', ${feeAmount.toFixed(4)}, '${dateStr}', '${sqlEsc(activeBizId)}', '${sqlEsc(resolvedStoreId)}')
      `,
        'Double Entry: Credit Escrow'
      );
    }

    syncAllAccountingSystems(`Workspace Task Sale #${orderId}`);
    syncSaleToFirestoreOfflineSafe({
      businessId: activeBizId,
      storeId: resolvedStoreId,
      customerName: 'Task Client',
      order: {
        id: orderId,
        customerId: selectedCustomerId ? Number(selectedCustomerId) : null,
        orderDate: dateStr,
        subtotal,
        tax: taxAmount,
        discount: discountAmount,
        total: totalAmount,
        paymentMethod,
        status: 'Completed',
        performed_by: localStorage.getItem('logged_in_user_name') || 'Task Operator',
      },
      items: [
        {
          id: orderItemId,
          productId: Number(serviceObj.id),
          productName: serviceObj.name,
          quantity: 1,
          unitPrice: Number(serviceObj.price),
        },
      ],
    });
    persistTablesToStorage();
    try {
      window.dispatchEvent(
        new CustomEvent('pos_sale_completed', {
          detail: { orderId, totalAmount, paymentMethod, store_id: activeStore },
        })
      );
      window.dispatchEvent(new Event('pos_data_updated'));
    } catch {}

    setShowFinancialsModal(false);
    setSelectedTaskForFinancials(null);
    triggerFeedback(
      `✓ Task [${selectedTaskForFinancials.title}] recorded on company financials under [${serviceObj.name}]!`,
      'success'
    );
  };

  // Filter Tasks List
  const filteredTasks = tasks.filter((t) => {
    if (taskFilter === 'archived') {
      return t.archived === true;
    }
    if (t.archived) {
      return false;
    }
    if (taskFilter === 'completed') return t.status === 'completed';
    if (taskFilter === 'pending') return t.status === 'needsAction';

    if (taskFilter === 'assigned_to_me') {
      const localStaffId = (typeof localStorage !== 'undefined' && localStorage.getItem('logged_in_staff_id')) || '';
      const localEmail =
        ((typeof localStorage !== 'undefined' && localStorage.getItem('logged_in_user_email')) || user?.email || '')
          .trim()
          .toLowerCase();
      const localName = ((typeof localStorage !== 'undefined' && localStorage.getItem('logged_in_user_name')) || '')
        .trim()
        .toLowerCase();

      if (localStaffId && t.assigneeId === localStaffId) return true;
      if (localEmail && t.assigneeEmail.toLowerCase() === localEmail) return true;

      const currentActiveAgent = localEmail
        ? staffList.find((s) => s.email?.toLowerCase() === localEmail)
        : undefined;
      if (currentActiveAgent && t.assigneeId === String(currentActiveAgent.id)) return true;

      if (localName && t.assigneeName.toLowerCase().includes(localName)) return true;
      const emailUser = localEmail.split('@')[0];
      if (emailUser && (t.assigneeName.toLowerCase().includes(emailUser) || t.description.toLowerCase().includes(emailUser))) {
        return true;
      }
      return t.assigneeId === 'general';
    }

    return true;
  });

  // ==========================================
  // GMAIL COURIER PANEL HANDLERS
  // ==========================================
  const handleSendEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accessToken) {
      triggerFeedback('Connect your Google Workspace account first to send emails via Gmail.', 'error');
      return;
    }
    if (!emailTo.trim() || !emailSubject.trim() || !emailBody.trim()) {
      triggerFeedback('Recipient email, subject, and content are required.', 'error');
      return;
    }

    setConfirmDialog({
      title: 'Send Email via Gmail?',
      message: `Transmit email "${emailSubject}" to ${emailTo} using your connected Google account?`,
      confirmLabel: 'Send Email',
      tone: 'indigo',
      onConfirm: async () => {
        setIsSendingEmail(true);
        try {
          const emailContent = [
            `To: ${emailTo}`,
            'Content-Type: text/html; charset=utf-8',
            'MIME-Version: 1.0',
            `Subject: ${emailSubject}`,
            '',
            emailBody.replace(/\n/g, '<br />'),
          ].join('\n');

          const encodedEmail = btoa(unescape(encodeURIComponent(emailContent)))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');

          const res = await fetch('https://www.googleapis.com/gmail/v1/users/me/messages/send', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ raw: encodedEmail }),
          });

          if (!res.ok) throw new Error('Gmail API failed to transmit message.');

          triggerFeedback(`Email dispatched to ${emailTo}!`, 'success');
          setEmailTo('');
          setEmailSubject('');
          setEmailBody('');
          fetchGmailMessages();
        } catch (err: any) {
          console.error(err);
          triggerFeedback(err?.message || 'Failed to send your email. Please retry.', 'error');
        } finally {
          setIsSendingEmail(false);
        }
      },
    });
  };

  // ==========================================
  // KEEP NOTES HANDLERS (Local POS + Optional Google Sync)
  // ==========================================
  const handleCreateKeepNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNoteTitle.trim() && !newNoteContent.trim()) {
      triggerFeedback('Keep note requires a title or content.', 'error');
      return;
    }

    setIsLoadingKeep(true);
    try {
      ensureWorkspaceTables();
      const activeBizId = getActiveBusinessId();
      const resolvedStoreId = getActiveStoreId(activeStore, activeBizId);
      const nowIso = new Date().toISOString();
      const noteId = `NOTE-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const titleText = newNoteTitle.trim() || 'Quick Note';
      const contentText = newNoteContent.trim() || 'No description.';
      let googleTaskId = '';

      if (accessToken) {
        try {
          const listRes = await fetch('https://www.googleapis.com/tasks/v1/users/@me/lists', {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          const listData = await listRes.json();
          const lists: any[] = listData.items || [];
          const foundKeepList = lists.find((l) => l.title === 'Shop Keep Notes');
          const keepListId = foundKeepList ? foundKeepList.id : '@default';

          const gRes = await fetch(`https://www.googleapis.com/tasks/v1/lists/${keepListId}/tasks`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              title: titleText,
              notes: `[COLOR: ${newNoteColor}] ${contentText}`,
            }),
          });
          if (gRes.ok) {
            const created = await gRes.json();
            googleTaskId = String(created.id || '');
          }
        } catch {
          // Local save still succeeds
        }
      }

      runSql(
        `INSERT INTO workspace_notes (id, title, content, color, google_task_id, updated_at, business_id, store_id) VALUES (
          '${sqlEsc(noteId)}',
          '${sqlEsc(titleText)}',
          '${sqlEsc(contentText)}',
          '${sqlEsc(newNoteColor)}',
          '${sqlEsc(googleTaskId)}',
          '${nowIso}',
          '${sqlEsc(activeBizId)}',
          '${sqlEsc(resolvedStoreId)}'
        )`,
        `Workspace Note: ${titleText}`
      );
      persistTablesToStorage();
      try {
        window.dispatchEvent(new Event('pos_data_updated'));
      } catch {}

      setNewNoteTitle('');
      setNewNoteContent('');
      setNewNoteColor('bg-white');
      await fetchKeepNotes();
      triggerFeedback('Note saved successfully!', 'success');
    } catch (err: any) {
      console.error(err);
      triggerFeedback(err?.message || 'Failed to save memo.', 'error');
    } finally {
      setIsLoadingKeep(false);
    }
  };

  const handleDeleteKeepNote = (note: KeepNote) => {
    setConfirmDialog({
      title: 'Delete Keep Note?',
      message: `Remove memo "${note.title}"?`,
      confirmLabel: 'Delete Note',
      tone: 'rose',
      onConfirm: async () => {
        setIsLoadingKeep(true);
        try {
          const activeBizId = getActiveBusinessId();
          const bizCond = activeBizId ? ` AND business_id = '${sqlEsc(activeBizId)}'` : '';
          if (!note.id.startsWith('GN-')) {
            runSql(`DELETE FROM workspace_notes WHERE id = '${sqlEsc(note.id)}'${bizCond}`, `Delete note: ${note.title}`);
            persistTablesToStorage();
            try {
              window.dispatchEvent(new Event('pos_data_updated'));
            } catch {}
          }

          if (accessToken && note.googleTaskId) {
            try {
              const listRes = await fetch('https://www.googleapis.com/tasks/v1/users/@me/lists', {
                headers: { Authorization: `Bearer ${accessToken}` },
              });
              const listData = await listRes.json();
              const lists: any[] = listData.items || [];
              const foundKeepList = lists.find((l) => l.title === 'Shop Keep Notes');
              const keepListId = foundKeepList ? foundKeepList.id : '@default';

              await fetch(`https://www.googleapis.com/tasks/v1/lists/${keepListId}/tasks/${note.googleTaskId}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${accessToken}` },
              });
            } catch {}
          }

          await fetchKeepNotes();
          triggerFeedback('Note deleted.', 'success');
        } catch (err: any) {
          console.error(err);
          triggerFeedback(err?.message || 'Failed to delete Keep note', 'error');
        } finally {
          setIsLoadingKeep(false);
        }
      },
    });
  };

  // ==========================================
  // GOOGLE DOCS & FORMS UTILITIES
  // ==========================================
  const handleCompileGoogleDoc = async () => {
    if (!accessToken) {
      triggerFeedback('Connect your Google Workspace account first to compile Google Docs.', 'error');
      return;
    }
    setIsCompilingDoc(true);
    setCompiledDocId(null);
    try {
      const dateStr = new Date().toLocaleDateString();
      const title =
        docCompileTemplate === 'summary'
          ? `Operations Report - ${dateStr}`
          : docCompileTemplate === 'transfer'
            ? `Stock Transfer Authorization Sheet - ${dateStr}`
            : `Shop Memorandum Details - ${dateStr}`;

      const createRes = await fetch('https://docs.googleapis.com/v1/documents', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title }),
      });

      if (!createRes.ok) throw new Error('Failed to initialize document structure.');
      const document = await createRes.json();
      const docId = document.documentId;

      let contentText = `SME SMART MANAGER - DOCUMENT ARCHIVE AUTOMATION\n`;
      contentText += `Generated: ${new Date().toUTCString()}\n`;
      contentText += `Store Node: ${activeStore.toUpperCase()}\n`;
      contentText += `Compiled on behalf of: ${user?.displayName || 'Authorized Agent'}\n`;
      contentText += `====================================================\n\n\n`;

      if (docCompileTemplate === 'summary') {
        const activeBizId = getActiveBusinessId();
        const bizWhere = activeBizId ? `WHERE business_id = '${sqlEsc(activeBizId)}'` : '';
        const prodCountRes = runSql(`SELECT COUNT(*) AS c FROM products ${bizWhere}`, 'Doc creator: prods count', true);
        const orderCountRes = runSql(`SELECT COUNT(*) AS c, SUM(total) AS sum FROM orders ${bizWhere}`, 'Doc creator: sales count', true);
        const prods = prodCountRes.success ? prodCountRes.data[0]?.c : 0;
        const totalSales = orderCountRes.success ? orderCountRes.data[0]?.c : 0;
        const totalSum = orderCountRes.success ? (orderCountRes.data[0]?.sum || 0).toFixed(2) : '0.00';

        contentText += `BUSINESS METRIC REPORT PREVIEW\n`;
        contentText += `------------------------------\n`;
        contentText += `- Total Catalog Products Registered: ${prods}\n`;
        contentText += `- Total Customer Sales Audits: ${totalSales}\n`;
        contentText += `- Sales Transaction Value Accumulated: ZMW ${totalSum}\n\n`;
        contentText += `Store staff coordinated operations successfully during this period.\n`;
      } else if (docCompileTemplate === 'transfer') {
        contentText += `STOCK TRANSFER SHEET REPORT\n`;
        contentText += `----------------------------\n`;
        contentText += `Confirm physical item counts and authorization signatures before moving inventory.\n`;
      } else {
        contentText += `NEW NOTES MEMORANDUM DATA DETAILS\n`;
        contentText += `---------------------------------\n`;
        contentText += `Write here key operations requirements for standard bookkeeping...\n`;
      }

      const updateRes = await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requests: [
            {
              insertText: {
                location: { index: 1 },
                text: contentText,
              },
            },
          ],
        }),
      });

      if (!updateRes.ok) throw new Error('Failed to update compiled context inside document.');

      setCompiledDocId(docId);
      triggerFeedback('Google Document Compiled Successfully!', 'success');
    } catch (err: any) {
      console.error(err);
      triggerFeedback(err?.message || 'Failed to compile document', 'error');
    } finally {
      setIsCompilingDoc(false);
    }
  };

  const handleFetchGoogleForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accessToken) {
      triggerFeedback('Connect your Google Workspace account first to sync Google Forms.', 'error');
      return;
    }
    if (!customFormId.trim()) {
      triggerFeedback('Form ID is required.', 'error');
      return;
    }

    setIsFetchingForm(true);
    setFormError(null);
    setFormDetail(null);
    try {
      const res = await fetch(`https://forms.googleapis.com/v1/forms/${customFormId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`Google Forms API replied with code [${res.status}]. Check form ownership or credentials.`);
      const data = await res.json();

      setFormDetail({
        id: data.formId,
        title: data.info?.title || 'Anonymous Google Form',
        description: data.info?.description || 'Active Questionnaire Link',
      });
      triggerFeedback('Form details synchronised!', 'success');
    } catch (err: any) {
      console.error(err);
      setFormError(err?.message || 'Could not reach Google Form. Make sure ID is accurate and has view permissions.');
    } finally {
      setIsFetchingForm(false);
    }
  };

  const renderGoogleAuthPrompt = (featureLabel: string) => (
    <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center flex flex-col items-center justify-center gap-3 min-h-[300px]">
      <div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
        <Shield size={22} />
      </div>
      <h3 className="text-sm font-black text-slate-800">{featureLabel} Requires Google Workspace Token</h3>
      <p className="text-xs text-slate-500 max-w-md leading-relaxed">
        Your POS Tasks & Keep Notes work offline and in POS Cloud without Google OAuth. To send Gmail messages or compile live Google Docs & Forms, link or refresh your Google Workspace session.
      </p>
      <button
        type="button"
        onClick={handleSignIn}
        disabled={isLoggingIn}
        className="flex items-center gap-2 py-2.5 px-5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-extrabold text-xs uppercase tracking-wider rounded-xl transition-all cursor-pointer shadow-xs active:scale-95"
      >
        {isLoggingIn ? <Loader2 size={14} className="animate-spin" /> : <Shield size={14} />}
        Connect / Refresh Google Workspace
      </button>
    </div>
  );

  return (
    <div id="workspace-coordination-dashboard" className="flex-1 overflow-y-auto bg-slate-50 p-4 md:p-6 flex flex-col gap-6 relative">
      {/* 1. Header & Quick Brand Session Info */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white border border-slate-200 p-5 rounded-2xl shadow-xs">
        <div className="flex items-start gap-4">
          <div className="p-3 bg-indigo-50 text-indigo-600 rounded-xl">
            <Sparkles size={24} />
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] uppercase font-black tracking-widest text-indigo-600 font-mono">
              Tasks & Operations Center
            </span>
            <h1 className="text-xl font-black text-slate-800 flex items-center gap-2">
              Team Tasks & Workspace Coordinator
            </h1>
            <p className="text-xs text-slate-500 leading-relaxed max-w-xl">
              Direct & assign store tasks to employees, track completion, post completed jobs to financials, and optionally sync with Google Workspace.
            </p>
          </div>
        </div>

        {/* Google Workspace OAuth Status */}
        <div className="flex items-center shrink-0">
          {!accessToken ? (
            <button
              id="gsi-sign-in-button"
              type="button"
              onClick={handleSignIn}
              disabled={isLoggingIn}
              className="flex items-center gap-2.5 py-2.5 px-4 bg-white text-slate-700 hover:text-slate-900 font-extrabold text-xs tracking-wide uppercase rounded-xl border border-slate-200 hover:border-slate-300 shadow-xs cursor-pointer hover:shadow-md transition-all shrink-0 active:scale-95"
            >
              {isLoggingIn ? (
                <Loader2 size={14} className="animate-spin text-slate-400" />
              ) : (
                <svg version="1.1" xmlns="http://www.w3.org/2000/svg" className="w-[15px] h-[15px]" viewBox="0 0 48 48">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                </svg>
              )}
              Link Google Sync
            </button>
          ) : (
            <div className="flex items-center gap-3 bg-emerald-50/60 border border-emerald-200 p-2 px-3.5 rounded-2xl">
              {user?.photoURL ? (
                <img src={user.photoURL} alt={user.displayName || 'Google user'} className="w-8 h-8 rounded-full border border-slate-200" referrerPolicy="no-referrer" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center font-bold text-xs uppercase">
                  {user?.displayName?.charAt(0) || 'G'}
                </div>
              )}
              <div className="flex flex-col">
                <span className="text-[11px] font-black text-slate-800 leading-tight">
                  {user?.displayName || 'Google Workspace Linked'}
                </span>
                <span className="text-[9px] font-mono text-emerald-700 font-semibold leading-none">
                  Cloud Sync Active ({userRole.toUpperCase()})
                </span>
              </div>
              <button
                type="button"
                onClick={handleSignOut}
                className="ml-3 p-1 px-2.5 bg-red-50 hover:bg-red-100 text-red-600 border border-red-100 hover:border-red-200 text-[10px] font-black uppercase rounded-lg tracking-wider transition-colors cursor-pointer"
              >
                Disconnect
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 2. Feedback Banner */}
      <AnimatePresence>
        {feedbackMsg && (
          <motion.div
            initial={{ opacity: 0, y: -15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -15 }}
            className={`p-3.5 px-4 rounded-xl text-xs font-semibold flex items-center justify-between border select-none ${
              feedbackMsg.status === 'success'
                ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                : feedbackMsg.status === 'error'
                  ? 'bg-red-50 text-red-800 border-red-200'
                  : 'bg-indigo-50 text-indigo-800 border-indigo-200'
            }`}
          >
            <span>{feedbackMsg.text}</span>
            <button
              type="button"
              onClick={() => setFeedbackMsg(null)}
              className="opacity-80 hover:opacity-100 font-bold uppercase text-[9px] hover:underline cursor-pointer"
            >
              dismiss
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Inner Work Navigation Tab Bar */}
      <div className="flex border-b border-slate-200 gap-2 overflow-x-auto select-none scrollbar-none whitespace-nowrap px-1 md:px-3 pt-1">
        <button
          type="button"
          onClick={() => setActiveWorkspaceTab('tasks')}
          className={`pb-2 px-3 font-black text-[11px] md:text-xs uppercase tracking-wider md:tracking-widest transition-all relative cursor-pointer ${
            activeWorkspaceTab === 'tasks' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-slate-400 hover:text-slate-700'
          }`}
        >
          <div className="flex items-center gap-1.5 justify-center">
            <CheckSquare size={13} />
            Direct & Assign Tasks
          </div>
        </button>

        <button
          type="button"
          onClick={() => setActiveWorkspaceTab('keep')}
          className={`pb-2 px-3 font-black text-[11px] md:text-xs uppercase tracking-wider md:tracking-widest transition-all relative cursor-pointer ${
            activeWorkspaceTab === 'keep' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-slate-400 hover:text-slate-700'
          }`}
        >
          <div className="flex items-center gap-1.5 justify-center">
            <Bookmark size={13} />
            Keep Notes Simulator
          </div>
        </button>

        <button
          type="button"
          onClick={() => setActiveWorkspaceTab('gmail')}
          className={`pb-2 px-3 font-black text-[11px] md:text-xs uppercase tracking-wider md:tracking-widest transition-all relative cursor-pointer ${
            activeWorkspaceTab === 'gmail' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-slate-400 hover:text-slate-700'
          }`}
        >
          <div className="flex items-center gap-1.5 justify-center">
            <Mail size={13} />
            Gmail Desk
          </div>
        </button>

        <button
          type="button"
          onClick={() => setActiveWorkspaceTab('docs_forms')}
          className={`pb-2 px-3 font-black text-[11px] md:text-xs uppercase tracking-wider md:tracking-widest transition-all relative cursor-pointer ${
            activeWorkspaceTab === 'docs_forms' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-slate-400 hover:text-slate-700'
          }`}
        >
          <div className="flex items-center gap-1.5 justify-center">
            <FileText size={13} />
            Docs & Forms Creator
          </div>
        </button>
      </div>

      {/* Tab View Container */}
      <div className="flex-1">
        {/* TAB ONE: DIRECT & ASSIGN TASKS COORDINATOR */}
        {activeWorkspaceTab === 'tasks' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-[400px]">
            {/* Task Assigner Form Panel (Owners / Managers) */}
            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-5 flex flex-col gap-4 self-start">
              <div className="border-b border-slate-100 pb-3">
                <span className="text-[10px] uppercase font-black tracking-widest text-emerald-600 font-mono">
                  Create operations directive
                </span>
                <h2 className="text-sm font-black text-slate-800 flex items-center gap-1.5 mt-0.5">
                  <UserPlus size={16} /> Direct & Assign Task
                </h2>
              </div>

              {userRole === 'sales' ? (
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl flex flex-col gap-2">
                  <Lock size={18} className="text-slate-400" />
                  <h4 className="text-xs font-bold text-slate-800">Directive Assignment Restricted</h4>
                  <p className="text-[11px] leading-relaxed text-slate-500">
                    Directive creation is reserved for the Business Owner or Store Manager levels. You can still view and mark tasks assigned to you as completed.
                  </p>
                </div>
              ) : (
                <form onSubmit={handleCreateTask} noValidate className="flex flex-col gap-3.5">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] uppercase font-mono font-bold text-slate-400">
                      Assigned Instruction *
                    </label>
                    <input
                      type="text"
                      value={newTaskTitle}
                      onChange={(e) => setNewTaskTitle(e.target.value)}
                      placeholder="e.g. Conduct inventory reconcile node A"
                      className="w-full text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-hidden focus:border-indigo-500 focus:bg-white"
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] uppercase font-mono font-bold text-slate-400">
                      Assign To Staff Agent
                    </label>
                    <select
                      value={newTaskAssignee}
                      onChange={(e) => setNewTaskAssignee(e.target.value)}
                      className="w-full text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 p-2.5 rounded-lg focus:outline-hidden focus:bg-white focus:border-indigo-500 cursor-pointer"
                    >
                      <option value="general">All Store Staff / General Directive</option>
                      {staffList.map((st) => (
                        <option key={st.id} value={String(st.id)}>
                          {st.first_name} {st.surname} ({st.email || st.role || 'Staff'})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] uppercase font-mono font-bold text-slate-400">Due Date</label>
                      <input
                        type="date"
                        value={newTaskDue}
                        onChange={(e) => setNewTaskDue(e.target.value)}
                        className="w-full text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-2.5 focus:outline-hidden cursor-pointer"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] uppercase font-mono font-bold text-slate-400">Priority Level</label>
                      <select
                        value={newTaskPriority}
                        onChange={(e) => setNewTaskPriority(e.target.value as 'LOW' | 'MEDIUM' | 'HIGH')}
                        className="w-full text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-2.5 focus:outline-hidden cursor-pointer"
                      >
                        <option value="LOW">LOW</option>
                        <option value="MEDIUM">MEDIUM</option>
                        <option value="HIGH">HIGH</option>
                      </select>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] uppercase font-mono font-bold text-slate-400">Notes / Details</label>
                    <textarea
                      rows={3}
                      value={newTaskDesc}
                      onChange={(e) => setNewTaskDesc(e.target.value)}
                      placeholder="Write extra instructions..."
                      className="w-full text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-hidden focus:border-indigo-500 focus:bg-white resize-none"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={isCreatingTask}
                    className="w-full flex items-center justify-center gap-1.5 py-3 p-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-extrabold text-[10.5px] uppercase tracking-wider rounded-xl transition-all cursor-pointer shadow-xs active:scale-95"
                  >
                    {isCreatingTask ? <Loader2 size={13} className="animate-spin" /> : <span>Direct & Assign Task</span>}
                  </button>
                </form>
              )}
            </div>

            {/* Directives Inbox */}
            <div className="lg:col-span-7 flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3 bg-white border border-slate-200 p-4 rounded-xl shadow-xs">
                <div className="flex items-center gap-2">
                  <ListTodo size={18} className="text-slate-500" />
                  <h3 className="text-xs font-black text-slate-800 uppercase tracking-widest">
                    Coordinated Directives Inbox
                  </h3>
                  <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-600">
                    {filteredTasks.length}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={fetchGoogleTasks}
                    disabled={isLoadingTasks}
                    className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-700 transition-colors cursor-pointer"
                    title="Refresh directives"
                  >
                    <RefreshCw size={13} className={isLoadingTasks ? 'animate-spin text-indigo-500' : ''} />
                  </button>

                  <select
                    value={taskFilter}
                    onChange={(e) => setTaskFilter(e.target.value as any)}
                    className="bg-slate-100 text-[10.5px] font-black uppercase text-slate-600 p-1.5 px-2.5 rounded-lg border-0 focus:outline-hidden cursor-pointer"
                  >
                    <option value="all">All Directives</option>
                    <option value="pending">Pending</option>
                    <option value="completed">Completed</option>
                    <option value="assigned_to_me">My Targets</option>
                    <option value="archived">Archived</option>
                  </select>
                </div>
              </div>

              {taskError && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-center justify-between gap-2 text-xs text-amber-800">
                  <div className="flex items-center gap-1.5 font-semibold">
                    <AlertCircle size={14} /> {taskError}
                  </div>
                  <button
                    type="button"
                    onClick={fetchGoogleTasks}
                    className="text-[10px] underline font-black uppercase cursor-pointer"
                  >
                    Retry
                  </button>
                </div>
              )}

              {isLoadingTasks && tasks.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-slate-400 gap-2 bg-white border border-slate-200 rounded-3xl min-h-[250px]">
                  <Loader2 size={24} className="animate-spin text-indigo-500" />
                  <span className="text-xs font-mono font-medium">Loading Directives...</span>
                </div>
              ) : filteredTasks.length === 0 ? (
                <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-slate-400 flex flex-col items-center justify-center min-h-[250px] gap-2">
                  <CheckCircle size={24} className="text-slate-300" />
                  <span className="text-xs font-bold text-slate-700">No Operations Directives Found</span>
                  <p className="text-[11px] text-slate-400 max-w-xs leading-normal">
                    Create a task using the Direct & Assign form on the left to assign work to staff or switch the filter above.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-2.5 max-h-[500px] overflow-y-auto pr-1">
                  {filteredTasks.map((tsk) => {
                    const isExpired = tsk.due && new Date(tsk.due) < new Date() && tsk.status !== 'completed';

                    return (
                      <div
                        key={tsk.id}
                        className={`p-4 border rounded-xl bg-white flex items-start justify-between gap-4 transition-all shadow-xs ${
                          tsk.status === 'completed'
                            ? 'border-emerald-200 bg-emerald-50/20'
                            : isExpired
                              ? 'border-red-200 bg-red-50/20'
                              : 'border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <button
                            type="button"
                            onClick={() => handleToggleTaskStatus(tsk)}
                            className={`mt-0.5 rounded-md w-5 h-5 border flex items-center justify-center transition-colors cursor-pointer shrink-0 ${
                              tsk.status === 'completed'
                                ? 'bg-emerald-600 border-emerald-600 text-white'
                                : 'border-slate-300 bg-slate-50 hover:border-slate-400'
                            }`}
                            title={tsk.status === 'completed' ? 'Mark as pending' : 'Mark as completed'}
                          >
                            {tsk.status === 'completed' && <CheckSquare size={13} />}
                          </button>

                          <div className="flex flex-col gap-1">
                            <span
                              className={`text-xs font-extrabold leading-snug ${
                                tsk.status === 'completed' ? 'line-through text-slate-400' : 'text-slate-800'
                              }`}
                            >
                              {tsk.title}
                            </span>

                            {tsk.description && (
                              <p className="text-[11px] text-slate-500 leading-normal bg-slate-50 border border-slate-100 p-2 rounded-lg italic select-text">
                                {tsk.description}
                              </p>
                            )}

                            <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[9.5px]">
                              <span className="flex items-center gap-1 p-1 px-1.5 bg-slate-100 border border-slate-200 rounded-sm font-semibold text-slate-600 shrink-0 select-none">
                                <UserCheck size={9} /> Assigned: <b className="text-slate-800">{tsk.assigneeName}</b>
                              </span>

                              <span
                                className={`p-1 px-1.5 rounded-sm font-mono font-extrabold shrink-0 select-none ${
                                  tsk.priority === 'HIGH'
                                    ? 'bg-red-50 text-red-600 border border-red-100'
                                    : tsk.priority === 'MEDIUM'
                                      ? 'bg-amber-50 text-amber-600 border border-amber-100'
                                      : 'bg-slate-100 text-slate-500 border border-slate-200'
                                }`}
                              >
                                {tsk.priority} PRIORITY
                              </span>

                              {tsk.due && (
                                <span
                                  className={`flex items-center gap-1 p-1 px-1.5 border rounded-sm font-semibold select-none ${
                                    isExpired ? 'bg-red-50 text-red-600 border-red-100' : 'bg-slate-100 text-slate-500 border-slate-200'
                                  }`}
                                >
                                  <Calendar size={9} /> Due: {new Date(tsk.due).toLocaleDateString()}
                                </span>
                              )}

                              {tsk.status === 'completed' && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => handleInitFinancialRecord(tsk)}
                                    className="flex items-center gap-1 bg-amber-100 text-amber-800 border border-amber-200 text-[10px] font-extrabold uppercase px-2 py-0.5 rounded cursor-pointer hover:bg-amber-200 transition-colors shrink-0"
                                  >
                                    Post to Financials
                                  </button>

                                  {!tsk.archived ? (
                                    <button
                                      type="button"
                                      onClick={() => handleArchiveTask(tsk, true)}
                                      className="flex items-center gap-1 bg-slate-100 text-slate-700 border border-slate-200 text-[10px] font-extrabold uppercase px-2 py-0.5 rounded cursor-pointer hover:bg-slate-200 transition-colors shrink-0"
                                    >
                                      <Archive size={10} /> Archive
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => handleArchiveTask(tsk, false)}
                                      className="flex items-center gap-1 bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-extrabold uppercase px-2 py-0.5 rounded cursor-pointer hover:bg-indigo-100 transition-colors shrink-0"
                                    >
                                      <Archive size={10} /> Unarchive
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          </div>
                        </div>

                        {userRole !== 'sales' && (
                          <button
                            type="button"
                            onClick={() => handleDeleteTask(tsk)}
                            className="p-1.5 text-slate-300 hover:text-red-500 rounded-lg hover:bg-red-50 transition-colors cursor-pointer"
                            title="Delete task permanently"
                          >
                            <Trash size={13} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB TWO: KEEP NOTES SIMULATOR */}
        {activeWorkspaceTab === 'keep' && (
          <div className="flex flex-col gap-6 min-h-[400px]">
            <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs">
              <div className="border-b border-slate-100 pb-3 mb-4">
                <span className="text-[10px] uppercase font-black tracking-widest text-indigo-500 font-mono">
                  Create Keep Note Memo
                </span>
                <h2 className="text-sm font-black text-slate-800 flex items-center gap-1.5 mt-0.5">
                  <Bookmark size={15} /> Log Operations Memo
                </h2>
              </div>

              <form onSubmit={handleCreateKeepNote} noValidate className="flex flex-col gap-4">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div className="md:col-span-3 flex flex-col gap-3">
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] uppercase font-mono font-bold text-slate-400">Note Title</label>
                      <input
                        type="text"
                        value={newNoteTitle}
                        onChange={(e) => setNewNoteTitle(e.target.value)}
                        placeholder="e.g. Supplier Contact details"
                        className="w-full text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-hidden focus:border-indigo-500"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] uppercase font-mono font-bold text-slate-400">
                        Note Content Context
                      </label>
                      <textarea
                        rows={3}
                        value={newNoteContent}
                        onChange={(e) => setNewNoteContent(e.target.value)}
                        placeholder="Write rapid notes, phone numbers or operations checklists..."
                        className="w-full text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-hidden focus:border-indigo-500 resize-none"
                      />
                    </div>
                  </div>

                  <div className="flex flex-col justify-between gap-3 bg-slate-50 border border-slate-200 rounded-xl p-4">
                    <div className="flex flex-col gap-2">
                      <label className="text-[10px] uppercase font-mono font-bold text-slate-400">Theme Color</label>
                      <div className="grid grid-cols-3 gap-1.5">
                        {[
                          { cls: 'bg-white', preview: 'bg-white border-slate-300' },
                          { cls: 'bg-yellow-50', preview: 'bg-yellow-100 border-yellow-300' },
                          { cls: 'bg-blue-50', preview: 'bg-blue-100 border-blue-300' },
                          { cls: 'bg-green-50', preview: 'bg-green-100 border-green-300' },
                          { cls: 'bg-red-50', preview: 'bg-red-100 border-red-300' },
                          { cls: 'bg-purple-50', preview: 'bg-purple-100 border-purple-300' },
                        ].map((c) => (
                          <button
                            key={c.cls}
                            type="button"
                            onClick={() => setNewNoteColor(c.cls)}
                            className={`w-6 h-6 rounded-full border cursor-pointer ${c.preview} ${
                              newNoteColor === c.cls ? 'ring-2 ring-indigo-600' : ''
                            }`}
                          />
                        ))}
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={isLoadingKeep}
                      className="w-full flex items-center justify-center gap-1 py-2 px-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-black text-[10px] uppercase tracking-wider rounded-lg shadow-sm cursor-pointer"
                    >
                      <Plus size={11} /> Save Note
                    </button>
                  </div>
                </div>
              </form>
            </div>

            {keepError && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800 font-semibold">
                {keepError}
              </div>
            )}

            {isLoadingKeep && keepNotes.length === 0 ? (
              <div className="flex items-center justify-center p-12 text-slate-400 gap-2 font-mono text-xs">
                <Loader2 size={16} className="animate-spin text-indigo-600" />
                Loading notes...
              </div>
            ) : keepNotes.length === 0 ? (
              <div className="bg-slate-50 border-2 border-dashed border-slate-200 p-8 rounded-2xl text-center text-slate-400">
                No memos saved yet. Add a quick note above to share operations reminders across your store.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4 select-text">
                {keepNotes.map((n) => (
                  <div
                    key={n.id}
                    className={`p-4 rounded-xl border border-slate-200 shadow-xs flex flex-col justify-between gap-3 transition-transform hover:-translate-y-0.5 hover:shadow-md ${n.color || 'bg-white'}`}
                  >
                    <div className="flex flex-col gap-1.5">
                      <h4 className="text-xs font-extrabold text-slate-800 truncate">{n.title}</h4>
                      <p className="text-[11px] leading-relaxed text-slate-600 whitespace-pre-wrap select-text">
                        {n.content}
                      </p>
                    </div>

                    <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-200/70 select-none">
                      <span className="text-[8.5px] font-mono text-slate-400">
                        {new Date(n.updatedAt).toLocaleDateString()}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleDeleteKeepNote(n)}
                        className="p-1 hover:bg-red-50 text-slate-300 hover:text-red-500 rounded border border-transparent hover:border-red-100 transition-colors cursor-pointer"
                        title="Delete note"
                      >
                        <Trash size={10} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB THREE: GMAIL COURIER PANEL */}
        {activeWorkspaceTab === 'gmail' && (
          !accessToken ? (
            renderGoogleAuthPrompt('Gmail Courier Desk')
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-[400px]">
              <div className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-5 flex flex-col gap-4 self-start">
                <div className="border-b border-slate-100 pb-3">
                  <span className="text-[10px] uppercase font-black tracking-widest text-indigo-500 font-mono">
                    Dispatched Courier
                  </span>
                  <h2 className="text-sm font-black text-slate-800 flex items-center gap-1.5 mt-0.5">
                    <Send size={15} /> Compose Gmail Invoice / Note
                  </h2>
                </div>

                <form onSubmit={handleSendEmail} noValidate className="flex flex-col gap-3.5">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] uppercase font-mono font-bold text-slate-400">
                      Recipient Email Address *
                    </label>
                    <input
                      type="email"
                      value={emailTo}
                      onChange={(e) => setEmailTo(e.target.value)}
                      placeholder="e.g. client@gmail.com"
                      className="w-full text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-hidden focus:border-indigo-500"
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] uppercase font-mono font-bold text-slate-400">
                      Subject Title *
                    </label>
                    <input
                      type="text"
                      value={emailSubject}
                      onChange={(e) => setEmailSubject(e.target.value)}
                      placeholder="e.g. Store Quotation ZMW 4,500.00"
                      className="w-full text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-hidden focus:border-indigo-500"
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] uppercase font-mono font-bold text-slate-400">
                      Email Message *
                    </label>
                    <textarea
                      rows={5}
                      value={emailBody}
                      onChange={(e) => setEmailBody(e.target.value)}
                      placeholder="Dear Client, please find below details..."
                      className="w-full text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-hidden focus:border-indigo-500"
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <span className="text-[9.5px] font-black tracking-wider uppercase text-slate-400">
                      Quick Template:
                    </span>
                    <div className="flex gap-1.5 flex-wrap">
                      <button
                        type="button"
                        onClick={() => {
                          setEmailSubject('Invoice Statement - Operational Receipts');
                          setEmailBody(
                            'Thank you for your business!\nHere are the details of your latest invoice.\nStatus: PAID.'
                          );
                        }}
                        className="p-1 px-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded text-[9.5px] font-bold cursor-pointer transition-colors border border-slate-200"
                      >
                        Invoice Receipt
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEmailSubject('Store Shift & Attendance Statement');
                          setEmailBody(
                            'Greetings Manager,\nI have completed logging shifts for this period. Please review payroll records.'
                          );
                        }}
                        className="p-1 px-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded text-[9.5px] font-bold cursor-pointer transition-colors border border-slate-200"
                      >
                        Staff Attendance
                      </button>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={isSendingEmail}
                    className="w-full flex items-center justify-center gap-1.5 py-3 px-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-extrabold text-[10.5px] uppercase tracking-wider rounded-xl shadow-xs transition-colors cursor-pointer"
                  >
                    {isSendingEmail ? <Loader2 size={13} className="animate-spin" /> : <span>Send Mail via Gmail</span>}
                  </button>
                </form>
              </div>

              <div className="lg:col-span-7 flex flex-col gap-4">
                <div className="flex items-center justify-between bg-white border border-slate-200 p-4 rounded-xl shadow-xs">
                  <div className="flex items-center gap-2">
                    <Mail size={18} className="text-slate-500" />
                    <h3 className="text-xs font-black text-slate-800 uppercase tracking-widest">
                      Gmail Inbox Recent Messages
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={fetchGmailMessages}
                    disabled={isLoadingGmail}
                    className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-700 transition-colors cursor-pointer"
                  >
                    <RefreshCw size={13} className={isLoadingGmail ? 'animate-spin text-indigo-500' : ''} />
                  </button>
                </div>

                {isLoadingGmail ? (
                  <div className="flex-1 flex flex-col items-center justify-center p-8 bg-white border border-slate-200 rounded-3xl min-h-[250px] text-slate-400 gap-1 font-mono text-xs">
                    <Loader2 size={18} className="animate-spin text-indigo-600" />
                    Syncing mail inbox...
                  </div>
                ) : gmailError ? (
                  <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-xs text-red-800">
                    Could not load recent Gmail list: {gmailError}
                  </div>
                ) : messages.length === 0 ? (
                  <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-slate-400 italic">
                    No recent inbox items found.
                  </div>
                ) : (
                  <div className="flex flex-col gap-3 max-h-[450px] overflow-y-auto pr-1">
                    {messages.map((msg) => (
                      <div
                        key={msg.id}
                        className="p-3.5 bg-white border border-slate-200 hover:border-slate-300 rounded-xl flex flex-col gap-1.5 transition-colors shadow-xs"
                      >
                        <div className="flex items-center justify-between text-[10.5px]">
                          <span className="font-extrabold text-slate-700 truncate max-w-[170px]">{msg.from}</span>
                          <span className="text-slate-400 font-medium font-mono shrink-0">{msg.date}</span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[11.5px] font-black text-slate-800 leading-tight truncate">
                            {msg.subject}
                          </span>
                          <p className="text-[11px] text-slate-400 italic leading-snug mt-1 line-clamp-2 select-text">
                            {msg.snippet}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        )}

        {/* TAB FOUR: DOCS & FORMS CREATOR */}
        {activeWorkspaceTab === 'docs_forms' && (
          !accessToken ? (
            renderGoogleAuthPrompt('Google Docs & Forms Creator')
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 min-h-[400px]">
              <div className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col gap-4 shadow-xs">
                <div className="border-b border-slate-100 pb-3">
                  <span className="text-[10px] uppercase font-black tracking-widest text-indigo-500 font-mono">
                    Google Docs Compiler
                  </span>
                  <h2 className="text-sm font-black text-slate-800 flex items-center gap-1.5 mt-0.5">
                    <FileText size={16} /> Document Creator Desk
                  </h2>
                </div>

                <p className="text-xs text-slate-500 leading-normal">
                  Convert operations logs or live sales metrics directly into formatted Google Docs inside your Google Drive.
                </p>

                <div className="flex flex-col gap-3.5 mt-2 bg-slate-50 border border-slate-200 rounded-xl p-4">
                  <div className="flex flex-col gap-2">
                    <label className="text-[10px] uppercase font-mono font-bold text-slate-400">
                      Compile Template Selection
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setDocCompileTemplate('summary')}
                        className={`flex-1 p-2 bg-white text-[10.5px] uppercase font-black border rounded-lg cursor-pointer text-center select-none ${
                          docCompileTemplate === 'summary' ? 'border-2 border-indigo-600 text-indigo-700' : 'border-slate-200 text-slate-400'
                        }`}
                      >
                        Sales Summary
                      </button>
                      <button
                        type="button"
                        onClick={() => setDocCompileTemplate('transfer')}
                        className={`flex-1 p-2 bg-white text-[10.5px] uppercase font-black border rounded-lg cursor-pointer text-center select-none ${
                          docCompileTemplate === 'transfer' ? 'border-2 border-indigo-600 text-indigo-700' : 'border-slate-200 text-slate-400'
                        }`}
                      >
                        Transfer Auth
                      </button>
                      <button
                        type="button"
                        onClick={() => setDocCompileTemplate('blank')}
                        className={`flex-1 p-2 bg-white text-[10.5px] uppercase font-black border rounded-lg cursor-pointer text-center select-none ${
                          docCompileTemplate === 'blank' ? 'border-2 border-indigo-600 text-indigo-700' : 'border-slate-200 text-slate-400'
                        }`}
                      >
                        Memo Template
                      </button>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={handleCompileGoogleDoc}
                    disabled={isCompilingDoc}
                    className="w-full mt-3 flex items-center justify-center gap-1.5 py-3 px-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-black text-[10px] tracking-widest uppercase rounded-lg shadow-sm cursor-pointer transition-colors"
                  >
                    {isCompilingDoc ? <Loader2 size={13} className="animate-spin" /> : <span>Compile Google Document</span>}
                  </button>

                  {compiledDocId && (
                    <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex flex-col gap-2 text-xs text-emerald-800">
                      <div className="flex items-center gap-1.5 font-bold">
                        <CheckCircle size={14} className="text-emerald-500" /> Compiled successfully!
                      </div>
                      <a
                        href={`https://docs.google.com/document/d/${compiledDocId}/edit`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-[10.5px] text-indigo-600 hover:underline font-black uppercase"
                      >
                        Open Newly Created Google Doc <ExternalLink size={10} />
                      </a>
                    </div>
                  )}
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col gap-4 shadow-xs">
                <div className="border-b border-slate-100 pb-3">
                  <span className="text-[10px] uppercase font-black tracking-widest text-indigo-500 font-mono">
                    Google Forms Aggregator
                  </span>
                  <h2 className="text-sm font-black text-slate-800 flex items-center gap-1.5 mt-0.5">
                    <FileSpreadsheet size={16} /> Customer Feedback / Timesheet Poll
                  </h2>
                </div>

                <p className="text-xs text-slate-500 leading-normal">
                  Link and verify Google Forms directly from your POS workspace.
                </p>

                <form onSubmit={handleFetchGoogleForm} noValidate className="flex flex-col gap-3.5">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] uppercase font-mono font-bold text-slate-400">
                      Insert Google Form ID
                    </label>
                    <input
                      type="text"
                      value={customFormId}
                      onChange={(e) => setCustomFormId(e.target.value)}
                      placeholder="e.g. 1vF8hzrSmC-R698S7ZAt90vL..."
                      className="w-full text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-hidden focus:border-indigo-500 focus:bg-white"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={isFetchingForm}
                    className="w-full flex items-center justify-center gap-1.5 py-3 px-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white font-black text-[10px] tracking-widest uppercase rounded-lg shadow-xs transition-colors cursor-pointer"
                  >
                    {isFetchingForm ? <Loader2 size={13} className="animate-spin" /> : <span>Synchronize Form Details</span>}
                  </button>
                </form>

                {(formDetail || formError) && (
                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex flex-col gap-2 text-xs font-mono">
                    {formError ? (
                      <span className="text-red-600">Error: {formError}</span>
                    ) : formDetail ? (
                      <div className="flex flex-col gap-1 text-slate-700">
                        <span className="font-extrabold text-slate-800 leading-tight">Title: {formDetail.title}</span>
                        {formDetail.description && (
                          <p className="text-[10px] leading-relaxed italic text-slate-500 mt-1">{formDetail.description}</p>
                        )}
                        <a
                          href={`https://docs.google.com/forms/d/${formDetail.id}/viewform`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-[10px] text-indigo-600 hover:underline font-black uppercase mt-1 select-none"
                        >
                          Open Live Form Questionnaire <ExternalLink size={9} />
                        </a>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            </div>
          )
        )}
      </div>

      {/* Financial Recording Dialog Modal overlay */}
      <AnimatePresence>
        {showFinancialsModal && selectedTaskForFinancials && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white border border-slate-200 rounded-3xl w-full max-w-md shadow-2xl overflow-hidden"
            >
              <div className="p-6 border-b border-slate-100 bg-amber-50">
                <span className="text-[10px] uppercase font-black tracking-widest text-amber-800 font-mono">
                  Completed Job / Directives
                </span>
                <h3 className="text-base font-black text-slate-800 flex items-center gap-2 mt-1">
                  Record Completed Task to Financials
                </h3>
                <p className="text-xs text-slate-600 mt-1">
                  Post task <strong className="text-slate-800">"{selectedTaskForFinancials.title}"</strong> to the double-entry ledger.
                </p>
              </div>

              <form onSubmit={handleRecordFinancials} className="p-6 flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] uppercase font-mono font-bold text-slate-400">
                    Select Corporate Service
                  </label>
                  <select
                    value={selectedServiceId}
                    onChange={(e) => setSelectedServiceId(e.target.value)}
                    required
                    className="w-full text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-hidden focus:border-amber-500 focus:bg-white cursor-pointer"
                  >
                    {financialsServices.map((s, index) => (
                      <option key={`${s.id}-${index}`} value={s.id.toString()}>
                        {s.name} ({Number(s.price || 0).toFixed(2)})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-[10px] uppercase font-mono font-bold text-slate-400">
                    Associate Customer (Optional)
                  </label>
                  <select
                    value={selectedCustomerId}
                    onChange={(e) => setSelectedCustomerId(e.target.value)}
                    className="w-full text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-hidden focus:border-amber-500 focus:bg-white cursor-pointer"
                  >
                    <option value="">-- Walk-in Customer --</option>
                    {customerList.map((c, index) => (
                      <option key={`${c.id}-${index}`} value={c.id.toString()}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-[10px] uppercase font-mono font-bold text-slate-400">Payment Channel</label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-1">
                    {['Cash', 'Airtel Money', 'MTN Mobile Money', 'Credit Card', ...customMethods.map((m) => m.name)].map(
                      (method) => (
                        <button
                          key={method}
                          type="button"
                          onClick={() => setPaymentMethod(method)}
                          className={`py-2 px-1.5 text-[10px] font-bold rounded-lg border text-center transition-all cursor-pointer ${
                            paymentMethod === method
                              ? 'bg-amber-600 border-amber-700 text-white shadow-xs'
                              : 'bg-slate-50 border-slate-200 hover:border-slate-300 text-slate-600'
                          }`}
                        >
                          {method}
                        </button>
                      )
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 mt-4 border-t border-slate-100 pt-4">
                  <button
                    type="button"
                    onClick={() => {
                      setShowFinancialsModal(false);
                      setSelectedTaskForFinancials(null);
                    }}
                    className="py-2.5 text-slate-500 hover:bg-slate-100 border border-slate-200 font-extrabold text-[10px] tracking-wider uppercase rounded-xl transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="py-2.5 bg-amber-600 hover:bg-amber-700 text-white font-extrabold text-[10px] tracking-wider uppercase rounded-xl shadow-xs transition-colors cursor-pointer"
                  >
                    Post Transaction
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* In-UI Confirmation Modal (Replaces blocked window.confirm dialogs) */}
      <AnimatePresence>
        {confirmDialog && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white border border-slate-200 rounded-2xl w-full max-w-sm p-6 shadow-2xl flex flex-col gap-4"
            >
              <div>
                <h3 className="text-sm font-black text-slate-900">{confirmDialog.title}</h3>
                <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">{confirmDialog.message}</p>
              </div>
              <div className="flex justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  disabled={isConfirmBusy}
                  onClick={() => setConfirmDialog(null)}
                  className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 text-xs font-bold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={isConfirmBusy}
                  onClick={async () => {
                    setIsConfirmBusy(true);
                    try {
                      await confirmDialog.onConfirm();
                    } finally {
                      setIsConfirmBusy(false);
                      setConfirmDialog(null);
                    }
                  }}
                  className={`px-4 py-2 rounded-xl text-white text-xs font-extrabold cursor-pointer flex items-center gap-1.5 ${
                    confirmDialog.tone === 'rose'
                      ? 'bg-rose-600 hover:bg-rose-700'
                      : confirmDialog.tone === 'emerald'
                        ? 'bg-emerald-600 hover:bg-emerald-700'
                        : 'bg-indigo-600 hover:bg-indigo-700'
                  }`}
                >
                  {isConfirmBusy && <Loader2 size={12} className="animate-spin" />}
                  {confirmDialog.confirmLabel}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
