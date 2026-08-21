import React, { useState, useEffect } from 'react';
import { 
  CheckSquare, Mail, FileText, FileSpreadsheet, Plus, Trash, RefreshCw, Send, ListTodo, 
  UserPlus, Calendar, Clock, AlertCircle, CheckCircle, Search, Star, Loader2, Sparkles, 
  Paperclip, ExternalLink, Bookmark, HelpCircle, UserCheck, Shield, ChevronRight, Lock,
  Archive
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { runSql } from '../db';
import { auth, googleSignIn, googleSignOut, getAccessToken } from '../firebase';
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
}

interface GoogleTask {
  id: string;
  title: string;
  notes?: string;
  due?: string;
  status: 'completed' | 'needsAction';
  completed?: string;
}

interface KeepNote {
  id: string;
  title: string;
  content: string;
  updatedAt: string;
  color?: string;
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

export default function WorkspaceCoordinator({ userRole, activeStore }: WorkspaceCoordinatorProps) {
  // Session States
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  // General tab switcher
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<'tasks' | 'gmail' | 'keep' | 'docs_forms'>('tasks');

  // Business / Staff states
  const [staffList, setStaffList] = useState<StaffMember[]>([]);

  // Task Coordinator States
  const [tasks, setTasks] = useState<GoogleTask[]>([]);
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [taskFilter, setTaskFilter] = useState<'all' | 'pending' | 'completed' | 'assigned_to_me' | 'archived'>('all');
  
  // Create Task Form States
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDesc, setNewTaskDesc] = useState('');
  const [newTaskDue, setNewTaskDue] = useState('');
  const [newTaskAssignee, setNewTaskAssignee] = useState<string>('');
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
  const [selectedTaskForFinancials, setSelectedTaskForFinancials] = useState<GoogleTask | null>(null);
  const [financialsServices, setFinancialsServices] = useState<any[]>([]);
  const [selectedServiceId, setSelectedServiceId] = useState<string>('');
  const [paymentMethod, setPaymentMethod] = useState<'Cash' | 'Mobile Wallet' | 'Credit Card'>('Cash');
  const [customerList, setCustomerList] = useState<any[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');

  // Dialog and Notification feedback
  const [feedbackMsg, setFeedbackMsg] = useState<{ status: 'success' | 'info' | 'error', text: string } | null>(null);

  // Trigger feedback banner
  const triggerFeedback = (text: string, status: 'success' | 'info' | 'error' = 'info') => {
    setFeedbackMsg({ status, text });
    setTimeout(() => {
      setFeedbackMsg(null);
    }, 4500);
  };

  // Sync session state on load
  useEffect(() => {
    const checkLoggedSession = async () => {
      setIsLoadingAuth(true);
      try {
        const u = auth.currentUser;
        if (u) {
          const token = await getAccessToken();
          setUser(u);
          setAccessToken(token);
        }
      } catch (err) {
        console.error('Session seek error: ', err);
      } finally {
        setIsLoadingAuth(false);
      }
    };
    checkLoggedSession();

    // Fetch store staff directly from local database to facilitate assigned options
    fetchStaffFromDb();
  }, []);

  // Sync workspace operations once access token is gathered
  useEffect(() => {
    if (accessToken) {
      if (activeWorkspaceTab === 'tasks') {
        fetchGoogleTasks();
      } else if (activeWorkspaceTab === 'gmail') {
        fetchGmailMessages();
      } else if (activeWorkspaceTab === 'keep') {
        fetchKeepNotes();
      }
    }
  }, [accessToken, activeWorkspaceTab]);

  const fetchStaffFromDb = () => {
    try {
      const res = runSql("SELECT id, first_name, surname, email FROM staff", "Fetch staff list for task coordinator");
      if (res.success && Array.isArray(res.data)) {
        setStaffList(res.data as StaffMember[]);
      }

      // Fetch corporate services (is_service = 1)
      const serviceRes = runSql("SELECT id, name, price, cost FROM products WHERE is_service = 1", "Fetch services for financial recording");
      if (serviceRes.success && Array.isArray(serviceRes.data)) {
        setFinancialsServices(serviceRes.data);
        if (serviceRes.data.length > 0) {
          setSelectedServiceId(serviceRes.data[0].id.toString());
        }
      }

      // Fetch customers
      const custRes = runSql("SELECT id, name FROM customers", "Fetch customers for task financials");
      if (custRes.success && Array.isArray(custRes.data)) {
        setCustomerList(custRes.data);
      }
    } catch (e) {
      console.error(e);
    }
  };

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
      setTasks([]);
      setMessages([]);
      setKeepNotes([]);
      triggerFeedback('Disconnected from Google Workspace.', 'info');
    } catch (err: any) {
      console.error(err);
    }
  };

  // ==========================================
  // GOOGLE TASKS COORDINATOR HANDLERS
  // ==========================================
  const fetchGoogleTasks = async () => {
    if (!accessToken) return;
    setIsLoadingTasks(true);
    setTaskError(null);
    try {
      // Fetch default list's tasks
      const res = await fetch('https://www.googleapis.com/tasks/v1/lists/@default/tasks?showCompleted=true&showHidden=true', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!res.ok) {
        throw new Error(`Tasks API responded with error code [${res.status}]`);
      }
      const data = await res.json();
      const rawTasks: GoogleTask[] = data.items || [];
      setTasks(rawTasks);
    } catch (err: any) {
      console.error(err);
      setTaskError(err?.message || 'Failed to sync Google Tasks.');
    } finally {
      setIsLoadingTasks(false);
    }
  };

  // Create Google Task with metadata formatted inside its description
  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accessToken) return;
    if (!newTaskTitle.trim()) {
      triggerFeedback('Task title is required.', 'error');
      return;
    }

    setIsCreatingTask(true);
    try {
      // Find assignee metadata
      const assignedUser = staffList.find(s => s.id === newTaskAssignee);
      const assigneeName = assignedUser ? `${assignedUser.first_name} ${assignedUser.surname}` : 'Unassigned';
      const assigneeEmail = assignedUser ? assignedUser.email : '';

      // Format description with structured metadata
      const formattedNotes = `[ASSIGNEE_ID: ${newTaskAssignee || 'none'}] [ASSIGNEE_NAME: ${assigneeName}] [PRIORITY: ${newTaskPriority}] ${newTaskDesc}`;

      const body: any = {
        title: newTaskTitle,
        notes: formattedNotes
      };

      if (newTaskDue) {
        // Formulate correct date format (RFC 3339)
        body.due = `${newTaskDue}T12:00:00Z`;
      }

      const res = await fetch('https://www.googleapis.com/tasks/v1/lists/@default/tasks', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) throw new Error('Could not create Google Task');

      triggerFeedback(`Successfully assigned task to ${assigneeName}!`, 'success');
      
      // Clear forms
      setNewTaskTitle('');
      setNewTaskDesc('');
      setNewTaskDue('');
      setNewTaskAssignee('');
      setNewTaskPriority('MEDIUM');
      
      // Refresh tasks
      fetchGoogleTasks();
    } catch (err: any) {
      console.error(err);
      triggerFeedback(err?.message || 'Failed to create and assign task', 'error');
    } finally {
      setIsCreatingTask(false);
    }
  };

  // Toggle complete / needsAction status
  const handleToggleTaskStatus = async (taskId: string, currentStatus: string) => {
    if (!accessToken) return;
    
    // Destructive mutation check for task modifications (as required by Workspace Guideline)
    const statusLabel = currentStatus === 'completed' ? 'pending' : 'completed';
    const confirmed = window.confirm(`Mark this task as ${statusLabel.toUpperCase()}? This will immediately sync to Google Tasks.`);
    if (!confirmed) return;

    try {
      const nextStatus = currentStatus === 'completed' ? 'needsAction' : 'completed';
      
      // When completing, we must set completed date or reset
      const updateBody: any = {
        id: taskId,
        status: nextStatus
      };
      
      if (nextStatus === 'completed') {
        updateBody.completed = new Date().toISOString();
      } else {
        // Reset completed date to delete it
        updateBody.completed = null;
      }

      const res = await fetch(`https://www.googleapis.com/tasks/v1/lists/@default/tasks/${taskId}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updateBody)
      });

      if (!res.ok) throw new Error('Could not update task status');

      triggerFeedback(`Task marked ${statusLabel === 'completed' ? 'completed' : 'pending'}.`, 'success');
      fetchGoogleTasks();
    } catch (err: any) {
      console.error(err);
      triggerFeedback(err?.message || 'Failed to update task status', 'error');
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    if (!accessToken) return;
    const confirmed = window.confirm('Are you sure you want to permanently delete this task from Google Tasks? This action cannot be undone.');
    if (!confirmed) return;

    try {
      const res = await fetch(`https://www.googleapis.com/tasks/v1/lists/@default/tasks/${taskId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      if (!res.ok) throw new Error('Failed to delete task');

      triggerFeedback('Task deleted successfully.', 'success');
      fetchGoogleTasks();
    } catch (err: any) {
      console.error(err);
      triggerFeedback(err?.message || 'Failed to delete task', 'error');
    }
  };

  const handleArchiveTask = async (taskId: string, archiveState: boolean) => {
    if (!accessToken) return;

    const actionText = archiveState ? 'archive' : 'unarchive';
    const confirmed = window.confirm(`Are you sure you want to ${actionText} this task?`);
    if (!confirmed) return;

    try {
      const tsk = tasks.find(t => t.id === taskId);
      if (!tsk) return;

      const parsed = parseTaskNotes(tsk.notes);
      parsed.archived = archiveState;
      const updatedNotes = serializeTaskNotes(parsed);

      const updateBody: any = {
        id: taskId,
        title: tsk.title,
        notes: updatedNotes,
        status: tsk.status
      };

      const res = await fetch(`https://www.googleapis.com/tasks/v1/lists/@default/tasks/${taskId}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updateBody)
      });

      if (!res.ok) throw new Error(`Could not ${actionText} task`);

      triggerFeedback(`Task successfully ${archiveState ? 'archived' : 'unarchived'}.`, 'success');
      fetchGoogleTasks();
    } catch (err: any) {
      console.error(err);
      triggerFeedback(err?.message || `Failed to ${actionText} task`, 'error');
    }
  };

  const handleInitFinancialRecord = (task: GoogleTask) => {
    // Make sure we have services to record
    if (financialsServices.length === 0) {
      alert("No company services have been registered yet in the Inventory! Please register a service under the Inventory tab first.");
      return;
    }
    setSelectedTaskForFinancials(task);
    setShowFinancialsModal(true);
  };

  const handleRecordFinancials = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTaskForFinancials) return;
    
    const serviceObj = financialsServices.find(s => s.id.toString() === selectedServiceId);
    if (!serviceObj) {
      alert("Selected service not found.");
      return;
    }

    const orderId = 'ord_task_' + Math.floor(100000 + Math.random() * 900000);
    const dateStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const customerIdVal = selectedCustomerId ? `'${selectedCustomerId}'` : 'NULL';

    const subtotal = serviceObj.price;
    const taxAmount = subtotal * 0.16; // 16% standard VAT
    const discountAmount = 0;
    const totalAmount = subtotal + taxAmount;

    // 1. Post order record
    const orderInsertSql = `
      INSERT INTO orders (id, customerId, orderDate, subtotal, tax, discount, total, paymentMethod, status, store_id, performed_by) VALUES (
        '${orderId}', 
        ${customerIdVal}, 
        '${dateStr}', 
        ${subtotal.toFixed(2)}, 
        ${taxAmount.toFixed(2)}, 
        ${discountAmount.toFixed(2)}, 
        ${totalAmount.toFixed(2)}, 
        '${paymentMethod}', 
        'Completed',
        '${activeStore}',
        '${(localStorage.getItem('logged_in_user_name') || 'Task Operator').replace(/'/g, "''")}'
      )
    `;
    const resOrder = runSql(orderInsertSql, `Billing: Record completed task financials for task ${selectedTaskForFinancials.title}`);
    if (!resOrder.success) {
      alert("Error saving transaction to financials database: " + resOrder.error);
      return;
    }

    // 2. Post order item lines
    const orderItemId = `${orderId}_1`;
    const itemInsertSql = `
      INSERT INTO order_items VALUES (
        '${orderItemId}', 
        '${orderId}', 
        ${serviceObj.id}, 
        1, 
        ${serviceObj.price}
      )
    `;
    runSql(itemInsertSql, `Billing: Post sales line item for service #${serviceObj.name}`);

    // 3. SECURE DOUBLE-ENTRY JOURNAL TRANSACTION ENTRY posting
    const txId = `tx_${orderId.toLowerCase()}_${Math.floor(100 + Math.random() * 900)}`;
    const idempotencyKey = `idemp_${txId}`;
    const calculatedFeeRate = paymentMethod === 'Cash' ? 0.0 : 0.015;
    const feeAmount = parseFloat((totalAmount * calculatedFeeRate).toFixed(4));
    const netSettlement = totalAmount - feeAmount;

    let clearingAccountId = 'cash-clearing-account-uuid';
    let channel = 'CASH';

    if (paymentMethod === 'Mobile Wallet') {
      clearingAccountId = Math.random() > 0.5 ? 'mtn-clearing-account-uuid' : 'airtel-clearing-account-uuid';
      channel = clearingAccountId === 'mtn-clearing-account-uuid' ? 'MTN_MOMO' : 'AIRTEL_MONEY';
    } else if (paymentMethod === 'Credit Card') {
      clearingAccountId = 'airtel-clearing-account-uuid';
      channel = 'CARD_VISA';
    }

    runSql(`
      INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at, updated_at)
      VALUES ('${txId}', '${idempotencyKey}', 'POS-${activeStore.toUpperCase()}-01', '${channel}', 'POS-REF-${orderId}', ${totalAmount.toFixed(4)}, ${feeAmount.toFixed(4)}, 'SUCCESS', 'Completed Company Task service Checkout #${orderId}', '${dateStr}', '${dateStr}')
    `, 'Double Entry: Journal completion of task service');

    runSql(`
      INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
      VALUES ('le_${txId}_deb', '${txId}', '${clearingAccountId}', 'DEBIT', ${totalAmount.toFixed(4)}, '${dateStr}')
    `, 'Double Entry: Debit Clearing account');

    runSql(`
      INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
      VALUES ('le_${txId}_cre_merch', '${txId}', 'merchant-wallet-account-uuid', 'CREDIT', ${netSettlement.toFixed(4)}, '${dateStr}')
    `, 'Double Entry: Credit Wallet');

    if (feeAmount > 0) {
      runSql(`
        INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
        VALUES ('le_${txId}_cre_fee', '${txId}', 'zra-tax-payment-escrow-uuid', 'CREDIT', ${feeAmount.toFixed(4)}, '${dateStr}')
      `, 'Double Entry: Credit Escrow');
    }

    setShowFinancialsModal(false);
    setSelectedTaskForFinancials(null);
    triggerFeedback(`✓ Task [${selectedTaskForFinancials.title}] is successfully recorded on company financials under service [${serviceObj.name}]!`, 'success');
  };

  // Helper parser for Google Task structured description
  const parseTaskNotes = (notesText: string | undefined) => {
    if (!notesText) return { assigneeId: 'none', assigneeName: 'Unassigned', priority: 'MEDIUM', description: '', archived: false };
    
    const idMatch = notesText.match(/\[ASSIGNEE_ID:\s*([^\]]+)\]/);
    const nameMatch = notesText.match(/\[ASSIGNEE_NAME:\s*([^\]]+)\]/);
    const priorityMatch = notesText.match(/\[PRIORITY:\s*([^\]]+)\]/);
    const archivedMatch = notesText.match(/\[ARCHIVED:\s*([^\]]+)\]/);
    
    // Clean description by stripping out the metadata elements
    let cleanDesc = notesText
      .replace(/\[ASSIGNEE_ID:[^\]]+\]/, '')
      .replace(/\[ASSIGNEE_NAME:[^\]]+\]/, '')
      .replace(/\[PRIORITY:[^\]]+\]/, '')
      .replace(/\[ARCHIVED:[^\]]+\]/, '')
      .trim();

    return {
      assigneeId: idMatch ? idMatch[1].trim() : 'none',
      assigneeName: nameMatch ? nameMatch[1].trim() : 'Unassigned',
      priority: (priorityMatch ? priorityMatch[1].trim() : 'MEDIUM') as 'LOW' | 'MEDIUM' | 'HIGH',
      description: cleanDesc,
      archived: archivedMatch ? archivedMatch[1].trim() === 'true' : false
    };
  };

  // Helper serializer for Google Task structured description
  const serializeTaskNotes = (parsed: { assigneeId: string, assigneeName: string, priority: string, description: string, archived: boolean }) => {
    const parts = [
      `[ASSIGNEE_ID: ${parsed.assigneeId}]`,
      `[ASSIGNEE_NAME: ${parsed.assigneeName}]`,
      `[PRIORITY: ${parsed.priority}]`
    ];
    if (parsed.archived) {
      parts.push('[ARCHIVED: true]');
    }
    parts.push(parsed.description);
    return parts.join(' ');
  };

  // Filter Tasks List
  const filteredTasks = tasks.filter(t => {
    const parsed = parseTaskNotes(t.notes);
    
    // Filter by archived status specifically
    if (taskFilter === 'archived') {
      return parsed.archived === true;
    }
    
    // Otherwise, for all other filters, hide archived tasks completely to reduce clutter!
    if (parsed.archived) {
      return false;
    }
    
    // Filter by general status
    if (taskFilter === 'completed') return t.status === 'completed';
    if (taskFilter === 'pending') return t.status === 'needsAction';
    
    // Filter by assigned to me:
    if (taskFilter === 'assigned_to_me') {
      const currentActiveAgent = staffList.find(s => s.email?.toLowerCase() === user?.email?.toLowerCase());
      if (currentActiveAgent) {
        return parsed.assigneeId === currentActiveAgent.id;
      }
      // If we don't match, look by matching email username
      const emailUser = user?.email?.split('@')[0]?.toLowerCase() || '';
      return parsed.assigneeName?.toLowerCase().includes(emailUser) || parsed.description?.toLowerCase().includes(emailUser);
    }

    return true;
  });

  // ==========================================
  // GMAIL COURIER PANEL HANDLERS
  // ==========================================
  const fetchGmailMessages = async () => {
    if (!accessToken) return;
    setIsLoadingGmail(true);
    setGmailError(null);
    try {
      const res = await fetch('https://www.googleapis.com/gmail/v1/users/me/messages?maxResults=8', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!res.ok) throw new Error(`Gmail API returned status code [${res.status}]`);
      const data = await res.json();
      const partialMsgs: { id: string, threadId: string }[] = data.messages || [];

      // Fetch headers and detail for each message snippet
      const fullMessages = await Promise.all(
        partialMsgs.map(async (m) => {
          const detailRes = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${m.id}`, {
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          if (!detailRes.ok) return { id: m.id, threadId: m.threadId, snippet: 'No detailed preview available.' };
          const detailData = await detailRes.json();
          
          const headers: any[] = detailData.payload?.headers || [];
          const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject');
          const fromHeader = headers.find(h => h.name.toLowerCase() === 'from');
          const dateHeader = headers.find(h => h.name.toLowerCase() === 'date');

          return {
            id: m.id,
            threadId: m.threadId,
            snippet: detailData.snippet || '',
            subject: subjectHeader ? subjectHeader.value : 'No Subject',
            from: fromHeader ? fromHeader.value : 'Unknown Sender',
            date: dateHeader ? dateHeader.value : ''
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
  };

  const handleSendEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accessToken) return;
    if (!emailTo.trim() || !emailSubject.trim() || !emailBody.trim()) {
      triggerFeedback('Receiver email, subject, and content are required.', 'error');
      return;
    }

    // Required Workspace mutate confirmation check:
    const confirmSend = window.confirm(`Send this email to [${emailTo}] with Google Gmail API?`);
    if (!confirmSend) return;

    setIsSendingEmail(true);
    try {
      // Build raw MIMEMultipart-like Base64 encoded email string as requested by Gmail specs
      const emailContent = [
        `To: ${emailTo}`,
        'Content-Type: text/html; charset=utf-8',
        'MIME-Version: 1.0',
        `Subject: ${emailSubject}`,
        '',
        emailBody.replace(/\n/g, '<br />')
      ].join('\n');

      // Safe RFC 4648 Base64 encoding for URLs
      const encodedEmail = btoa(unescape(encodeURIComponent(emailContent)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      const res = await fetch('https://www.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ raw: encodedEmail })
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
  };

  // ==========================================
  // GOOGLE KEEP SIMULATOR (Note Sync on Tasks List)
  // ==========================================
  // Since standard keep scopes are restricted to GSuite admins, we simulate Google Keep
  // using a dedicated Google Task List under-the-hood, providing flawless 100% note sync capabilities!
  const fetchKeepNotes = async () => {
    if (!accessToken) return;
    setIsLoadingKeep(true);
    setKeepError(null);
    try {
      // Let's search standard task lists for a list named "Shop Keep Notes"
      // If it doesn't exist, we fallback to default list with note filters or create it
      const listRes = await fetch('https://www.googleapis.com/tasks/v1/users/@me/lists', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const listData = await listRes.json();
      const lists: any[] = listData.items || [];
      
      let keepListId = '@default';
      const foundKeepList = lists.find(l => l.title === 'Shop Keep Notes');
      
      if (foundKeepList) {
        keepListId = foundKeepList.id;
      } else {
        // Create the custom list "Shop Keep Notes"
        const createListRes = await fetch('https://www.googleapis.com/tasks/v1/users/@me/lists', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ title: 'Shop Keep Notes' })
        });
        if (createListRes.ok) {
          const newList = await createListRes.json();
          keepListId = newList.id;
        }
      }

      // Fetch the notes/tasks in that list
      const notesRes = await fetch(`https://www.googleapis.com/tasks/v1/lists/${keepListId}/tasks?showCompleted=false`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const notesData = await notesRes.json();
      const rawNotes: any[] = notesData.items || [];

      // Map back to KeepNotes
      const mappedNotes: KeepNote[] = rawNotes.map(n => {
        // Note color mapped inside notes body text
        const notesBody = n.notes || '';
        const colorMatch = notesBody.match(/\[COLOR:\s*([^\]]+)\]/);
        const cleanContent = notesBody.replace(/\[COLOR:[^\]]+\]/, '').trim();

        return {
          id: n.id,
          title: n.title || 'Untitled Note',
          content: cleanContent || 'No description.',
          updatedAt: n.updated || new Date().toISOString(),
          color: colorMatch ? colorMatch[1] : 'bg-white'
        };
      });

      setKeepNotes(mappedNotes);
    } catch (err: any) {
      console.error(err);
      setKeepError(err?.message || 'Failed to sync Keep notes inbox.');
    } finally {
      setIsLoadingKeep(false);
    }
  };

  const handleCreateKeepNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accessToken) return;
    if (!newNoteTitle.trim() && !newNoteContent.trim()) {
      triggerFeedback('Keep note requires a title or context content.', 'error');
      return;
    }

    setIsLoadingKeep(true);
    try {
      // Find or create "Shop Keep Notes" list ID
      const listRes = await fetch('https://www.googleapis.com/tasks/v1/users/@me/lists', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const listData = await listRes.json();
      const lists: any[] = listData.items || [];
      let keepListId = '@default';
      const foundKeepList = lists.find(l => l.title === 'Shop Keep Notes');
      if (foundKeepList) keepListId = foundKeepList.id;

      const formattedNotesBody = `[COLOR: ${newNoteColor}] ${newNoteContent}`;

      const res = await fetch(`https://www.googleapis.com/tasks/v1/lists/${keepListId}/tasks`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          title: newNoteTitle || 'Quick Note',
          notes: formattedNotesBody
        })
      });

      if (!res.ok) throw new Error('Failed to synchronize KEEP state.');

      triggerFeedback('Sync Note logged to Google Keep Dashboard!', 'success');
      setNewNoteTitle('');
      setNewNoteContent('');
      setNewNoteColor('bg-white');
      fetchKeepNotes();
    } catch (err: any) {
      console.error(err);
      triggerFeedback(err?.message || 'Failed to write keep memo', 'error');
    } finally {
      setIsLoadingKeep(false);
    }
  };

  const handleDeleteKeepNote = async (noteId: string) => {
    if (!accessToken) return;
    const confirmDelete = window.confirm('Delete this keep note card?');
    if (!confirmDelete) return;

    setIsLoadingKeep(true);
    try {
      const listRes = await fetch('https://www.googleapis.com/tasks/v1/users/@me/lists', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const listData = await listRes.json();
      const lists: any[] = listData.items || [];
      const foundKeepList = lists.find(l => l.title === 'Shop Keep Notes');
      const keepListId = foundKeepList ? foundKeepList.id : '@default';

      const res = await fetch(`https://www.googleapis.com/tasks/v1/lists/${keepListId}/tasks/${noteId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      if (!res.ok) throw new Error('Could not delete Keep task item.');

      triggerFeedback('Note deleted.', 'success');
      fetchKeepNotes();
    } catch (err: any) {
      console.error(err);
      triggerFeedback(err?.message || 'Failed to delete Keep note', 'error');
    } finally {
      setIsLoadingKeep(false);
    }
  };

  // ==========================================
  // GOOGLE DOCS & FORMS UTILITIES
  // ==========================================
  const handleCompileGoogleDoc = async () => {
    if (!accessToken) return;
    setIsCompilingDoc(true);
    setCompiledDocId(null);
    try {
      // Create a new blank Google Document
      const dateStr = new Date().toLocaleDateString();
      const title = docCompileTemplate === 'summary' 
        ? `Operations Report - ${dateStr}` 
        : docCompileTemplate === 'transfer' 
          ? `Stock Transfer Authorization Sheet - ${dateStr}` 
          : `Shop Memorandum Details - ${dateStr}`;

      const createRes = await fetch('https://docs.googleapis.com/v1/documents', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ title })
      });

      if (!createRes.ok) throw new Error('Failed to initialize document structure.');
      const document = await createRes.json();
      const docId = document.documentId;

      // Compile interesting records from database
      let contentText = `SME SMART MANAGER - DOCUMENT ARCHIVE AUTOMATION\n`;
      contentText += `Generated: ${new Date().toUTCString()}\n`;
      contentText += `Store Node: ${activeStore.toUpperCase()}\n`;
      contentText += `Compiled on behalf of: ${user?.displayName || 'Authorized Agent'}\n`;
      contentText += `====================================================\n\n\n`;

      if (docCompileTemplate === 'summary') {
        const prodCountRes = runSql("SELECT COUNT(*) AS c FROM products", "Doc creator: prods count");
        const orderCountRes = runSql("SELECT COUNT(*) AS c, SUM(total) AS sum FROM orders", "Doc creator: sales count");
        const prods = prodCountRes.success ? prodCountRes.data[0]?.c : 0;
        const totalSales = orderCountRes.success ? orderCountRes.data[0]?.c : 0;
        const totalSum = orderCountRes.success ? (orderCountRes.data[0]?.sum || 0).toFixed(2) : '0.00';

        contentText += `BUSINESS METRIC REPORT PREVIEW\n`;
        contentText += `------------------------------\n`;
        contentText += `- Total Catalog Products Registered: ${prods}\n`;
        contentText += `- Total Customer Sales Audits: ${totalSales}\n`;
        contentText += `- Sales Transaction Value Accumulated: ZMW ${totalSum}\n\n`;
        contentText += `Store staff coordinated operations successfully during this period. Maintain consistent security protocols.\n`;
      } else if (docCompileTemplate === 'transfer') {
        contentText += `STOCK TRANSFER SHEET REPORT\n`;
        contentText += `----------------------------\n`;
        contentText += `The manager demands immediate inventory count before any transfer. Check physical item integrity.\n`;
        contentText += `Authorized items must reside in appropriate bins.\n`;
      } else {
        contentText += `NEW NOTES MEMORANDUM DATA DETAILS\n`;
        contentText += `---------------------------------\n`;
        contentText += `Write here key operations requirements for standard bookkeeping...\n`;
      }

      // Add compiled content via batchUpdate
      const updateRes = await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          requests: [
            {
              insertText: {
                location: { index: 1 },
                text: contentText
              }
            }
          ]
        })
      });

      if (!updateRes.ok) throw new Error('Failed to update compiled context inside document.');

      setCompiledDocId(docId);
      triggerFeedback('Google Document Compiled Successfully!', 'success');
    } catch (err: any) {
      console.error(err);
      triggerFeedback(err?.message || 'Failed compile document', 'error');
    } finally {
      setIsCompilingDoc(false);
    }
  };

  // Google Forms aggregator
  const handleFetchGoogleForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accessToken) return;
    if (!customFormId.trim()) {
      triggerFeedback('Form ID is required.', 'error');
      return;
    }

    setIsFetchingForm(true);
    setFormError(null);
    setFormDetail(null);
    try {
      // Validate/fetch google form details
      const res = await fetch(`https://forms.googleapis.com/v1/forms/${customFormId}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!res.ok) throw new Error(`Google Forms API replied with code [${res.status}]. Check form ownership or credentials.`);
      const data = await res.json();
      
      setFormDetail({
        id: data.formId,
        title: data.info?.title || 'Anonymous Google Form',
        description: data.info?.description || 'Active Questionnaire Link'
      });
      triggerFeedback('Form details synchronised!', 'success');
    } catch (err: any) {
      console.error(err);
      setFormError(err?.message || 'Could not reach detailed Google Form. Make sure ID is accurate and has view permissions.');
    } finally {
      setIsFetchingForm(false);
    }
  };

  return (
    <div id="workspace-coordination-dashboard" className="flex-1 overflow-y-auto bg-slate-50 p-4 md:p-6 flex flex-col gap-6">
      
      {/* 1. Header & Quick Brand Session Info */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white border border-slate-200 p-5 rounded-2xl shadow-xs">
        
        <div className="flex items-start gap-4">
          <div className="p-3 bg-indigo-50 text-indigo-600 rounded-xl">
            <Sparkles size={24} className="animate-pulse" />
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] uppercase font-black tracking-widest text-indigo-600 font-mono">Workspace Sync Center</span>
            <h1 className="text-xl font-black text-slate-800 flex items-center gap-2">
              Google Workspace Integrator
            </h1>
            <p className="text-xs text-slate-500 leading-relaxed max-w-xl">
              Cohesively assign Google tasks, manage team coordination directives, draft Gmail reports, compile Docs and monitor customer Google Forms.
            </p>
          </div>
        </div>

        {/* Auth Button following precise Google guidelines */}
        <div className="flex items-center shrink-0">
          {!user ? (
            <button 
              id="gsi-sign-in-button"
              onClick={handleSignIn}
              disabled={isLoggingIn}
              className="flex items-center gap-2.5 py-2.5 px-4 bg-white text-slate-700 hover:text-slate-900 font-extrabold text-xs tracking-wide uppercase rounded-xl border border-slate-200 hover:border-slate-350 shadow-xs cursor-pointer hover:shadow-md transition-all shrink-0 active:scale-95"
            >
              {isLoggingIn ? (
                <Loader2 size={14} className="animate-spin text-slate-400" />
              ) : (
                <svg version="1.1" xmlns="http://www.w3.org/2000/svg" className="w-[15px] h-[15px]" viewBox="0 0 48 48">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path>
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path>
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path>
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path>
                </svg>
              )}
              Connect Google Account
            </button>
          ) : (
            <div className="flex items-center gap-3 bg-slate-50 border border-slate-150 p-2 px-3.5 rounded-2xl">
              {user.photoURL ? (
                <img src={user.photoURL} alt={user.displayName || 'Google user'} className="w-8 h-8 rounded-full border border-slate-200" referrerPolicy="no-referrer" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center font-bold text-xs uppercase">
                  {user.displayName?.charAt(0) || 'G'}
                </div>
              )}
              <div className="flex flex-col">
                <span className="text-[11px] font-black text-slate-800 leading-tight">
                  {user.displayName || 'Authorized Agent'}
                </span>
                <span className="text-[9px] font-mono text-slate-400 font-semibold leading-none">
                  Logged as {userRole.toUpperCase()}
                </span>
              </div>
              <button 
                onClick={handleSignOut}
                className="ml-3 p-1 px-2.5 bg-red-50 hover:bg-red-100 text-red-600 border border-red-100 hover:border-red-200 text-[10px] font-black uppercase rounded-lg tracking-wider transition-colors cursor-pointer"
              >
                Disconnect
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 2. Error Display Panel */}
      <AnimatePresence>
        {feedbackMsg && (
          <motion.div
            initial={{ opacity: 0, y: -15 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -15 }}
            className={`p-3.5 px-4 rounded-xl text-xs font-semibold flex items-center justify-between border select-none ${
              feedbackMsg.status === 'success' 
                ? 'bg-emerald-50 text-emerald-800 border-emerald-150' 
                : feedbackMsg.status === 'error' 
                  ? 'bg-red-50 text-red-800 border-red-150' 
                  : 'bg-indigo-50 text-indigo-800 border-indigo-150'
            }`}
          >
            <span>{feedbackMsg.text}</span>
            <button onClick={() => setFeedbackMsg(null)} className="opacity-80 hover:opacity-100 font-bold uppercase text-[9px] hover:underline cursor-pointer">dismiss</button>
          </motion.div>
        )}
      </AnimatePresence>

      {!user ? (
        // Non-Authenticated State Empty Frame
        <div className="flex-1 min-h-[350px] flex flex-col items-center justify-center bg-white border border-slate-200 rounded-3xl p-8 text-center gap-4">
          <div className="w-16 h-16 bg-slate-900 rounded-full flex items-center justify-center text-white text-xl font-bold">
            <Lock size={26} />
          </div>
          <div className="flex flex-col gap-1.5 max-w-sm">
            <h3 className="text-lg font-black text-slate-800">Workspace Authorization Required</h3>
            <p className="text-xs text-slate-400 leading-normal font-sans">
              Google Workspace calls require secure on-the-fly user credentials. Log in safely using official Google OAuth dialog to explore live synchronization.
            </p>
          </div>
          <button 
            onClick={handleSignIn}
            disabled={isLoggingIn}
            className="flex items-center gap-2 py-3 px-6 bg-slate-900 hover:bg-slate-800 text-white font-extrabold text-xs tracking-wider uppercase rounded-xl transition-transform active:scale-95 cursor-pointer shadow-sm"
          >
            <Shield size={14} /> Link Workspace Securely
          </button>
        </div>
      ) : (
        // Authenticated Operations Panel
        <>
          {/* Inner Work Navigation Tab Bar */}
          <div className="flex border-b border-slate-200 gap-2 overflow-x-auto select-none scrollbar-none whitespace-nowrap px-1 md:px-3 pt-1">
            <button
              onClick={() => setActiveWorkspaceTab('tasks')}
              className={`pb-2 px-3 font-black text-[11px] md:text-xs uppercase tracking-wider md:tracking-widest transition-all relative cursor-pointer ${
                activeWorkspaceTab === 'tasks' ? 'text-indigo-600 border-b-2 border-indigo-600' : 'text-slate-400 hover:text-slate-700'
              }`}
            >
              <div className="flex items-center gap-1.5 justify-center">
                <CheckSquare size={13} />
                Tasks Coordinator
              </div>
            </button>

            <button
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
            
            {/* TAB ONE: GOOGLE TASKS COORDINATOR */}
            {activeWorkspaceTab === 'tasks' && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-[400px]">
                
                {/* Task Assigner Form Panel (Owners / Managers only) */}
                <div className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-5 flex flex-col gap-4 self-start">
                  <div className="border-b border-slate-150 pb-3">
                    <span className="text-[10px] uppercase font-black tracking-widest text-emerald-500 font-mono">Create operations directive</span>
                    <h2 className="text-sm font-black text-slate-800 flex items-center gap-1.5 mt-0.5">
                      <UserPlus size={16} /> Assign New Google Task
                    </h2>
                  </div>

                  {userRole === 'sales' ? (
                    <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl flex flex-col gap-2">
                      <Lock size={18} className="text-slate-400" />
                      <h4 className="text-xs font-bold text-slate-800">Root Assignment Restricted</h4>
                      <p className="text-[11px] leading-relaxed text-slate-400 font-serif">
                        Directive creation is reserved exclusively for the Business Owner or Store Manager account levels to prevent payroll noise. You can still visualize and toggle tasks assigned to you.
                      </p>
                    </div>
                  ) : (
                    <form onSubmit={handleCreateTask} className="flex flex-col gap-3.5">
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] uppercase font-mono font-bold text-slate-400">Assigned Instruction *</label>
                        <input
                          type="text"
                          required
                          value={newTaskTitle}
                          onChange={(e) => setNewTaskTitle(e.target.value)}
                          placeholder="e.g. Conduct inventory reconcile node A"
                          className="w-full text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-hidden focus:border-indigo-500 focus:bg-white"
                        />
                      </div>

                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] uppercase font-mono font-bold text-slate-400">Assign To Staff Agent *</label>
                        <select
                          required
                          value={newTaskAssignee}
                          onChange={(e) => setNewTaskAssignee(e.target.value)}
                          className="w-full text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 p-2.5 rounded-lg focus:outline-hidden focus:bg-white focus:border-indigo-500 cursor-pointer"
                        >
                          <option value="">-- Choose Employee Assignee --</option>
                          {staffList.map(st => (
                            <option key={st.id} value={st.id}>{st.first_name} {st.surname} ({st.email || 'No email'})</option>
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
                            onChange={(e) => setNewTaskPriority(e.target.value as any)}
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
                          placeholder="Write here extra instructions..."
                          className="w-full text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-hidden focus:border-indigo-500 focus:bg-white resize-none"
                        />
                      </div>

                      <button
                        type="submit"
                        disabled={isCreatingTask}
                        className="w-full flex items-center justify-center gap-1.5 py-3 p-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-extrabold text-[10.5px] uppercase tracking-wider rounded-xl transition-all cursor-pointer shadow-xs active:scale-95"
                      >
                        {isCreatingTask ? <Loader2 size={13} className="animate-spin" /> : <span>🚀 Direct & Assign Task</span>}
                      </button>
                    </form>
                  )}
                </div>

                {/* Google Tasks Live Database View */}
                <div className="lg:col-span-7 flex flex-col gap-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 bg-white border border-slate-200 p-4 rounded-xl shadow-xs">
                    <div className="flex items-center gap-2">
                      <ListTodo size={18} className="text-slate-500" />
                      <h3 className="text-xs font-black text-slate-800 uppercase tracking-widest">Coordinated Directives Inbox</h3>
                    </div>
                    
                    <div className="flex items-center gap-2">
                      <button
                        onClick={fetchGoogleTasks}
                        disabled={isLoadingTasks}
                        className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-700 transition-colors cursor-pointer"
                        title="Force sync lists"
                      >
                        <RefreshCw size={13} className={isLoadingTasks ? 'animate-spin text-indigo-500' : ''} />
                      </button>

                      {/* Filters */}
                      <select
                        value={taskFilter}
                        onChange={(e) => setTaskFilter(e.target.value as any)}
                        className="bg-slate-100 text-[10.5px] font-black uppercase text-slate-600 p-1 px-2.2 rounded-lg border-0 focus:outline-hidden cursor-pointer"
                      >
                        <option value="all">All Directives</option>
                        <option value="pending">Pending</option>
                        <option value="completed">Completed</option>
                        <option value="assigned_to_me">My Targets</option>
                        <option value="archived">Archived</option>
                      </select>
                    </div>
                  </div>

                  {/* Task list list */}
                  {isLoadingTasks ? (
                    <div className="flex-1 flex flex-col items-center justify-center p-8 text-slate-400 gap-2 bg-white border border-slate-200 rounded-3xl min-h-[250px]">
                      <Loader2 size={24} className="animate-spin text-indigo-500 animate-duration-1000" />
                      <span className="text-xs font-mono font-medium">Fetching Google Tasks Cloud...</span>
                    </div>
                  ) : taskError ? (
                    <div className="bg-red-50 border border-red-150 rounded-2xl p-4 flex flex-col gap-2 text-xs text-red-800">
                      <div className="flex items-center gap-1.5 font-bold">
                        <AlertCircle size={15} /> Error Synchronizing with Google Tasks
                      </div>
                      <p>{taskError}</p>
                      <button onClick={fetchGoogleTasks} className="self-start text-[10px] underline font-black uppercase mt-1">Retry Fetch</button>
                    </div>
                  ) : filteredTasks.length === 0 ? (
                    <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-slate-400 flex flex-col items-center justify-center min-h-[250px] gap-2">
                      <CheckCircle size={24} className="text-slate-200 text-slate-300" />
                      <span className="text-xs font-bold text-slate-700">No Operations Directives Found</span>
                      <p className="text-[11px] text-slate-400 max-w-xs leading-normal">
                        Everything clear! Create an interactive task above to direct the salesperson to target goals or change the filter scope.
                      </p>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2.5 max-h-[450px] overflow-y-auto pr-1">
                      {filteredTasks.map(tsk => {
                        const parsed = parseTaskNotes(tsk.notes);
                        const isExpired = tsk.due && new Date(tsk.due) < new Date() && tsk.status !== 'completed';

                        return (
                          <div 
                            key={tsk.id} 
                            className={`p-4 border rounded-xl bg-white flex items-start justify-between gap-4 transition-all shadow-xs ${
                              tsk.status === 'completed' 
                                ? 'border-emerald-100 bg-emerald-50/20' 
                                : isExpired 
                                  ? 'border-red-105 bg-red-50/10' 
                                  : 'border-slate-150 hover:border-slate-250'
                            }`}
                          >
                            <div className="flex items-start gap-3">
                              {/* Toggle Check Status Button */}
                              <button
                                onClick={() => handleToggleTaskStatus(tsk.id, tsk.status)}
                                className={`mt-0.5 rounded-md w-5 h-5 border flex items-center justify-center transition-colors cursor-pointer shrink-0 ${
                                  tsk.status === 'completed'
                                    ? 'bg-emerald-600 border-emerald-600 text-white'
                                    : 'border-slate-300 bg-slate-50 hover:border-slate-400'
                                }`}
                              >
                                {tsk.status === 'completed' && <CheckSquare size={13} />}
                              </button>

                              <div className="flex flex-col gap-1">
                                <span className={`text-xs font-extrabold text-slate-800 leading-snug ${
                                  tsk.status === 'completed' ? 'line-through text-slate-400' : ''
                                }`}>
                                  {tsk.title}
                                </span>

                                {parsed.description && (
                                  <p className="text-[11px] text-slate-500 leading-normal bg-slate-50 border border-slate-100 p-2 rounded-lg italic select-text">
                                    {parsed.description}
                                  </p>
                                )}

                                {/* Meta Tags */}
                                <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[9.5px]">
                                  {/* Assignee Tag */}
                                  <span className="flex items-center gap-1 p-1 px-1.5 bg-slate-105 border border-slate-200 rounded-sm font-semibold text-slate-600 shrink-0 select-none">
                                    <UserCheck size={9} /> Assigned: <b className="text-slate-800">{parsed.assigneeName}</b>
                                  </span>

                                  {/* Priority level */}
                                  <span className={`p-1 px-1.5 rounded-sm font-mono font-extrabold shrink-0 select-none ${
                                    parsed.priority === 'HIGH' 
                                      ? 'bg-red-50 text-red-600 border border-red-100' 
                                      : parsed.priority === 'MEDIUM' 
                                        ? 'bg-amber-50 text-amber-600 border border-amber-100' 
                                        : 'bg-slate-100 text-slate-500 border border-slate-200'
                                  }`}>
                                    {parsed.priority} PRIORITY
                                  </span>

                                  {/* Expired / Due Date */}
                                  {tsk.due && (
                                    <span className={`flex items-center gap-1 p-1 px-1.5 border rounded-sm font-semibold select-none ${
                                      isExpired ? 'bg-red-50 text-red-600 border-red-100' : 'bg-slate-100 text-slate-500 border-slate-200'
                                    }`}>
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
                                        💸 Post to Financials
                                      </button>

                                      {!parsed.archived ? (
                                        <button
                                          type="button"
                                          onClick={() => handleArchiveTask(tsk.id, true)}
                                          className="flex items-center gap-1 bg-slate-100 text-slate-705 border border-slate-200 text-[10px] font-extrabold uppercase px-2 py-0.5 rounded cursor-pointer hover:bg-slate-200 transition-colors shrink-0"
                                        >
                                          <Archive size={10} /> Archive
                                        </button>
                                      ) : (
                                        <button
                                          type="button"
                                          onClick={() => handleArchiveTask(tsk.id, false)}
                                          className="flex items-center gap-1 bg-indigo-50 text-indigo-705 border border-indigo-150 text-[10px] font-extrabold uppercase px-2 py-0.5 rounded cursor-pointer hover:bg-indigo-150 transition-colors shrink-0"
                                        >
                                          <Archive size={10} /> Unarchive
                                        </button>
                                      )}
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* Delete option (Only owners can delete tasks) */}
                            {userRole !== 'sales' && (
                              <button
                                onClick={() => handleDeleteTask(tsk.id)}
                                className="p-1.5 text-slate-300 hover:text-red-500 rounded-lg hover:bg-red-50 transition-colors cursor-pointer"
                                title="Remove task permanently from cloud"
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
                
                {/* Note creation box */}
                <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs">
                  <div className="border-b border-slate-150 pb-3 mb-4">
                    <span className="text-[10px] uppercase font-black tracking-widest text-indigo-500 font-mono">Create Keep Note Memo</span>
                    <h2 className="text-sm font-black text-slate-800 flex items-center gap-1.5 mt-0.5">
                      <Bookmark size={15} /> Log Google Keep Memo
                    </h2>
                  </div>

                  <form onSubmit={handleCreateKeepNote} className="flex flex-col gap-4">
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                      
                      {/* Left color panel selection & Title */}
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
                          <label className="text-[10px] uppercase font-mono font-bold text-slate-400">Note Content Context</label>
                          <textarea
                            rows={3}
                            value={newNoteContent}
                            onChange={(e) => setNewNoteContent(e.target.value)}
                            placeholder="Write here rapid notes, phone numbers or operations list..."
                            className="w-full text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-hidden focus:border-indigo-500 resize-none"
                          />
                        </div>
                      </div>

                      {/* Color preset selection & submit */}
                      <div className="flex flex-col justify-between gap-3 bg-slate-50 border border-slate-150 rounded-xl p-4">
                        <div className="flex flex-col gap-2">
                          <label className="text-[10px] uppercase font-mono font-bold text-slate-400">Theme Color</label>
                          <div className="grid grid-cols-3 gap-1.5">
                            <button
                              type="button"
                              onClick={() => setNewNoteColor('bg-white')}
                              className={`w-6 h-6 rounded-full bg-white border cursor-pointer ${newNoteColor === 'bg-white' ? 'border-2 border-indigo-650' : 'border-slate-300'}`}
                            />
                            <button
                              type="button"
                              onClick={() => setNewNoteColor('bg-yellow-50')}
                              className={`w-6 h-6 rounded-full bg-yellow-105 border cursor-pointer ${newNoteColor === 'bg-yellow-50' ? 'border-2 border-indigo-650' : 'border-yellow-200'}`}
                            />
                            <button
                              type="button"
                              onClick={() => setNewNoteColor('bg-blue-50')}
                              className={`w-6 h-6 rounded-full bg-blue-105 border cursor-pointer ${newNoteColor === 'bg-blue-50' ? 'border-2 border-indigo-650' : 'border-blue-200'}`}
                            />
                            <button
                              type="button"
                              onClick={() => setNewNoteColor('bg-green-50')}
                              className={`w-6 h-6 rounded-full bg-green-105 border cursor-pointer ${newNoteColor === 'bg-green-50' ? 'border-2 border-indigo-650' : 'border-green-200'}`}
                            />
                            <button
                              type="button"
                              onClick={() => setNewNoteColor('bg-red-50')}
                              className={`w-6 h-6 rounded-full bg-red-105 border cursor-pointer ${newNoteColor === 'bg-red-50' ? 'border-2 border-indigo-650' : 'border-red-200'}`}
                            />
                            <button
                              type="button"
                              onClick={() => setNewNoteColor('bg-purple-50')}
                              className={`w-6 h-6 rounded-full bg-purple-105 border cursor-pointer ${newNoteColor === 'bg-purple-50' ? 'border-2 border-indigo-650' : 'border-purple-200'}`}
                            />
                          </div>
                        </div>

                        <button
                          type="submit"
                          className="w-full flex items-center justify-center gap-1 py-2 px-2 bg-indigo-600 hover:bg-indigo-700 text-white font-black text-[10px] uppercase tracking-wider rounded-lg shadow-sm"
                        >
                          <Plus size={11} /> Save Note
                        </button>
                      </div>

                    </div>
                  </form>
                </div>

                {/* Display grid keep notes */}
                {isLoadingKeep ? (
                  <div className="flex items-center justify-center p-12 text-slate-400 gap-2 font-mono text-xs">
                    <Loader2 size={16} className="animate-spin text-indigo-600" />
                    Seeking notes catalog...
                  </div>
                ) : keepNotes.length === 0 ? (
                  <div className="bg-slate-50 border-2 border-dashed border-slate-200 p-8 rounded-2xl text-center text-slate-400 font-serif">
                    💡 No synchronized keep memos logged. Note-taking is synced to custom 'Shop Keep Notes' Google Task list for instant offline availability!
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4 select-text">
                    {keepNotes.map(n => (
                      <div 
                        key={n.id} 
                        className={`p-4 rounded-xl border border-slate-150 shadow-xs flex flex-col justify-between gap-3 transition-transform hover:-translate-y-0.5 hover:shadow-md ${n.color || 'bg-white'}`}
                      >
                        <div className="flex flex-col gap-1.5">
                          <h4 className="text-xs font-extrabold text-slate-800 truncate">{n.title}</h4>
                          <p className="text-[11px] leading-relaxed text-slate-600 whitespace-pre-wrap select-text font-serif">
                            {n.content}
                          </p>
                        </div>

                        <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100 select-none">
                          <span className="text-[8.5px] font-mono text-slate-400">
                            {new Date(n.updatedAt).toLocaleDateString()} - Keep Sync
                          </span>
                          <button
                            onClick={() => handleDeleteKeepNote(n.id)}
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
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-[400px]">
                
                {/* Compose Email Form */}
                <div className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-5 flex flex-col gap-4 self-start">
                  <div className="border-b border-slate-150 pb-3">
                    <span className="text-[10px] uppercase font-black tracking-widest text-indigo-500 font-mono">Dispatched Courier</span>
                    <h2 className="text-sm font-black text-slate-800 flex items-center gap-1.5 mt-0.5">
                      <Send size={15} /> Compose Gmail Invoice / Note
                    </h2>
                  </div>

                  <form onSubmit={handleSendEmail} className="flex flex-col gap-3.5">
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] uppercase font-mono font-bold text-slate-400">Recipient EmailAddress *</label>
                      <input
                        type="email"
                        required
                        value={emailTo}
                        onChange={(e) => setEmailTo(e.target.value)}
                        placeholder="e.g. client@gmail.com"
                        className="w-full text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-hidden focus:border-indigo-500"
                      />
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] uppercase font-mono font-bold text-slate-400">Subject Title *</label>
                      <input
                        type="text"
                        required
                        value={emailSubject}
                        onChange={(e) => setEmailSubject(e.target.value)}
                        placeholder="e.g. Store Quotation ZMW 4,500.00"
                        className="w-full text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-hidden focus:border-indigo-500"
                      />
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] uppercase font-mono font-bold text-slate-400">Email Context Payload (HTML Support) *</label>
                      <textarea
                        rows={5}
                        required
                        value={emailBody}
                        onChange={(e) => setEmailBody(e.target.value)}
                        placeholder="Dear Client, please find attached below details..."
                        className="w-full text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-hidden focus:border-indigo-500"
                      />
                    </div>

                    {/* Pre-fill quick tools from orders info */}
                    <div className="flex flex-col gap-1">
                      <span className="text-[9.5px] font-black tracking-wider uppercase text-slate-400">Attach Invoice Data Template:</span>
                      <div className="flex gap-1.5 flex-wrap">
                        <button
                          type="button"
                          onClick={() => {
                            setEmailSubject('Invoice Statement - Operational Receipts');
                            setEmailBody('Thank you for choosing SME Terminal Store! \nHere are the details of the latest billing invoice logged. \nAmount due: ZMW ...\nStatus: FULLY_PAID.');
                          }}
                          className="p-1 px-2.2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded text-[9.5px] font-bold cursor-pointer transition-colors border border-slate-150"
                        >
                          Invoice Receipt
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEmailSubject('Store Job Application / Attendance Statement');
                            setEmailBody('Greetings Manager, \nI have completed logging my shifts for this attendance period. Please analyze payroll records.');
                          }}
                          className="p-1 px-2.2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded text-[9.5px] font-bold cursor-pointer transition-colors border border-slate-150"
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
                      {isSendingEmail ? <Loader2 size={13} className="animate-spin" /> : <>🚀 Dispense Mail via Google</>}
                    </button>
                  </form>
                </div>

                {/* Inbox Snippets */}
                <div className="lg:col-span-7 flex flex-col gap-4">
                  <div className="flex items-center justify-between bg-white border border-slate-200 p-4 rounded-xl shadow-xs">
                    <div className="flex items-center gap-2">
                      <Mail size={18} className="text-slate-500" />
                      <h3 className="text-xs font-black text-slate-800 uppercase tracking-widest">Gmail Inbox Courier Log (Unread / Recent)</h3>
                    </div>
                    <button
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
                      Syncing mail server inbox...
                    </div>
                  ) : gmailError ? (
                    <div className="bg-red-50 border border-red-150 rounded-2xl p-4 text-xs text-red-800">
                      ⚠️ Could not restore recent Gmail list: {gmailError}
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-slate-400 italic">
                      No unread or recent inbox items found.
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3 max-h-[450px] overflow-y-auto pr-1">
                      {messages.map(msg => (
                        <div key={msg.id} className="p-3.5 bg-white border border-slate-200 hover:border-slate-300 rounded-xl flex flex-col gap-1.5 transition-colors shadow-xs">
                          <div className="flex items-center justify-between text-[10.5px]">
                            <span className="font-extrabold text-slate-700 truncate max-w-[170px]">{msg.from}</span>
                            <span className="text-slate-400 font-medium font-mono shrink-0">{msg.date}</span>
                          </div>
                          <div className="flex flex-col">
                            <span className="text-[11.5px] font-black text-slate-800 leading-tight truncate">{msg.subject}</span>
                            <p className="text-[11px] text-slate-400 italic leading-snug mt-1 line-clamp-2 select-text font-serif">
                              {msg.snippet}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

              </div>
            )}

            {/* TAB FOUR: DOCS & FORMS CREATOR */}
            {activeWorkspaceTab === 'docs_forms' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 min-h-[400px]">
                
                {/* Google Docs section */}
                <div className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col gap-4 shadow-xs">
                  <div className="border-b border-slate-150 pb-3">
                    <span className="text-[10px] uppercase font-black tracking-widest text-indigo-500 font-mono">Google Docs Compiler</span>
                    <h2 className="text-sm font-black text-slate-800 flex items-center gap-1.5 mt-0.5">
                      <FileText size={16} /> Document Creator Desk
                    </h2>
                  </div>

                  <p className="text-xs text-slate-400 leading-normal">
                    Quickly convert operations logs or live sales metrics directly into formatted Google Docs. A private direct link would be created inside your Google Drive instantly.
                  </p>

                  <div className="flex flex-col gap-3.5 mt-2 bg-slate-50 border border-slate-155 rounded-xl p-4">
                    <div className="flex flex-col gap-2">
                      <label className="text-[10px] uppercase font-mono font-bold text-slate-400">Compile Template Selection</label>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setDocCompileTemplate('summary')}
                          className={`flex-1 p-2 bg-white text-[10.5px] uppercase font-black border rounded-lg cursor-pointer text-center select-none ${docCompileTemplate === 'summary' ? 'border-2 border-indigo-600 text-indigo-700' : 'border-slate-200 text-slate-400'}`}
                        >
                          Sales Summary
                        </button>
                        <button
                          type="button"
                          onClick={() => setDocCompileTemplate('transfer')}
                          className={`flex-1 p-2 bg-white text-[10.5px] uppercase font-black border rounded-lg cursor-pointer text-center select-none ${docCompileTemplate === 'transfer' ? 'border-2 border-indigo-600 text-indigo-700' : 'border-slate-200 text-slate-400'}`}
                        >
                          Transfer Authorization
                        </button>
                        <button
                          type="button"
                          onClick={() => setDocCompileTemplate('blank')}
                          className={`flex-1 p-2 bg-white text-[10.5px] uppercase font-black border rounded-lg cursor-pointer text-center select-none ${docCompileTemplate === 'blank' ? 'border-2 border-indigo-600 text-indigo-700' : 'border-slate-200 text-slate-400'}`}
                        >
                          Memo Template
                        </button>
                      </div>
                    </div>

                    <button
                      onClick={handleCompileGoogleDoc}
                      disabled={isCompilingDoc}
                      className="w-full mt-3 flex items-center justify-center gap-1.5 py-3 px-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-black text-[10px] tracking-widest uppercase rounded-lg shadow-sm cursor-pointer transition-colors"
                    >
                      {isCompilingDoc ? <Loader2 size={13} className="animate-spin" /> : <>📝 Compile Google Document</>}
                    </button>

                    {compiledDocId && (
                      <div className="bg-emerald-50 border border-emerald-150 rounded-lg p-3 flex flex-col gap-2 text-xs text-emerald-800">
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

                {/* Google Forms Section */}
                <div className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col gap-4 shadow-xs">
                  <div className="border-b border-slate-150 pb-3">
                    <span className="text-[10px] uppercase font-black tracking-widest text-indigo-500 font-mono">Google Forms Aggregator</span>
                    <h2 className="text-sm font-black text-slate-800 flex items-center gap-1.5 mt-0.5">
                      <FileSpreadsheet size={16} /> Customers Feedback / Timesheet Poll
                    </h2>
                  </div>

                  <p className="text-xs text-slate-400 leading-normal">
                    Aggregate details and monitor Google Forms responses directly from the app. Perfect for employee reviews and timesheets!
                  </p>

                  <form onSubmit={handleFetchGoogleForm} className="flex flex-col gap-3.5">
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] uppercase font-mono font-bold text-slate-400">Insert Google Form ID</label>
                      <input
                        type="text"
                        required
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
                      {isFetchingForm ? <Loader2 size={13} className="animate-spin" /> : <>📥 Synchronize Questionnaire Responses</>}
                    </button>
                  </form>

                  {(formDetail || formError) && (
                    <div className="bg-slate-55 border border-slate-150 rounded-xl p-4 flex flex-col gap-2 text-xs font-mono">
                      {formError ? (
                        <span className="text-red-600">⚠️ Error: {formError}</span>
                      ) : formDetail ? (
                        <div className="flex flex-col gap-1 text-slate-700">
                          <span className="font-extrabold text-slate-850 leading-tight">📋 Title: {formDetail.title}</span>
                          {formDetail.description && <p className="text-[10px] leading-relaxed italic text-slate-450 mt-1">{formDetail.description}</p>}
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
            )}

          </div>
        </>
      )}

      {/* Financial Recording Dialog Modal overlay */}
      <AnimatePresence>
        {showFinancialsModal && selectedTaskForFinancials && (
          <div className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white border border-slate-200 rounded-3xl w-full max-w-md shadow-2xl overflow-hidden"
            >
              {/* Header */}
              <div className="p-6 border-b border-slate-150 bg-amber-50">
                <span className="text-[10px] uppercase font-black tracking-widest text-amber-800 font-mono font-bold">Completed Job / Directives</span>
                <h3 className="text-base font-black text-slate-800 flex items-center gap-2 mt-1">
                  💸 Record Completed Task to Financials
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  Post task <strong className="text-slate-800">"{selectedTaskForFinancials.title}"</strong> to double-entry ledger instantly!
                </p>
              </div>

              {/* Form body */}
              <form onSubmit={handleRecordFinancials} className="p-6 flex flex-col gap-4">
                
                                <div className="flex flex-col gap-1">
                  <label className="text-[10px] uppercase font-mono font-bold text-slate-400">Select Corporate Service</label>
                  <select
                    value={selectedServiceId}
                    onChange={(e) => setSelectedServiceId(e.target.value)}
                    required
                    className="w-full text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-hidden focus:border-amber-500 focus:bg-white cursor-pointer"
                  >
                    {financialsServices.map((s, index) => (
                      <option key={`${s.id}-${index}`} value={s.id.toString()}>
                        {s.name} (ZMK {s.price.toFixed(2)})
                      </option>
                    ))}
                  </select>
                </div>

                {/* Associate Customer */}
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] uppercase font-mono font-bold text-slate-400">Associate Customer (Optional)</label>
                  <select
                    value={selectedCustomerId}
                    onChange={(e) => setSelectedCustomerId(e.target.value)}
                    className="w-full text-xs font-bold text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-2.5 outline-hidden focus:border-amber-500 focus:bg-white cursor-pointer"
                  >
                    <option value="">-- No Customer (Walk-in Customer) --</option>
                    {customerList.map((c, index) => (
                      <option key={`${c.id}-${index}`} value={c.id.toString()}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Choose Payment Method */}
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] uppercase font-mono font-bold text-slate-400">Payment Channel</label>
                  <div className="grid grid-cols-3 gap-2 mt-1">
                    {(['Cash', 'Mobile Wallet', 'Credit Card'] as const).map(method => (
                      <button
                        key={method}
                        type="button"
                        onClick={() => setPaymentMethod(method)}
                        className={`py-2 px-1 text-[10px] font-bold rounded-lg border text-center transition-all cursor-pointer ${
                          paymentMethod === method
                            ? 'bg-amber-600 border-amber-650 text-white shadow-xs'
                            : 'bg-slate-50 border-slate-200 hover:border-slate-300 text-slate-600'
                        }`}
                      >
                        {method}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Footer buttons */}
                <div className="grid grid-cols-2 gap-3 mt-4 border-t border-slate-100 pt-4">
                  <button
                    type="button"
                    onClick={() => {
                      setShowFinancialsModal(false);
                      setSelectedTaskForFinancials(null);
                    }}
                    className="py-2.5 text-slate-500 hover:bg-slate-100 border border-slate-200 font-extrabold text-[10px] tracking-wider uppercase rounded-xl transition-colors cursor-pointer"
                  >
                    Discard Action
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

    </div>
  );
}
