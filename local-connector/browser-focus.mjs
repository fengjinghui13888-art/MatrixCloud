/**
 * Move the connector-owned XHS tab to the foreground after the creator
 * account has been verified. The workbench never needs to copy or render the
 * QR image; the customer scans the QR directly in this visible browser.
 */
export async function focusBrowserPage({session, findPage, connectPage}) {
  const pageId=await findPage(session);
  if(!pageId)return false;
  const connection=await connectPage(session.debugPort);
  try {
    await connection.page.selectTab(pageId);
    await connection.activate();
    return true;
  } finally {
    await connection.close();
  }
}
