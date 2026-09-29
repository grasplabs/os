import journal from './meta/_journal.json';
import m0000 from './0000_chats.sql';
import m0001 from './0001_restricted_chats.sql';
import m0002 from './0002_agent_sessions.sql';
import m0003 from './0003_chat_sources.sql';
import m0004 from './0004_personal_chats.sql';

  export default {
    journal,
    migrations: {
      m0000,
m0001,
m0002,
m0003,
m0004
    }
  }
  