LIBRARY MANAGEMENT SYSTEM

BookNest uses C# and ASP.NET Core with SQLite. It can run locally for
development or be deployed as a public HTTPS website.

Main project files:
- Program.cs: server, database, and library operations
- wwwroot\index.html: page structure
- wwwroot\app.js: website screens and browser behavior
- wwwroot\styles.css: site styling
- LibraryManagement.csproj: .NET and package settings
- LibraryManagement.http: sample API requests
- README.txt: run instructions and account workflow

To run once:
1. Open this folder in PowerShell or a terminal.
2. Run: dotnet run --project .\LibraryManagement.csproj
3. Visit: http://localhost:5080

The app uses the existing database at
bin\Debug\net8.0-windows\library_management.db when present. Otherwise, it
creates App_Data\library_management.db.

## GitHub and public hosting

GitHub stores and versions the source code. GitHub Pages only serves static
files; it cannot run this ASP.NET Core server or its SQLite database.

For a free public demo, the included render.yaml describes a Render Free web
service. Connect the GitHub repository to Render and create a Blueprint from
render.yaml. The app will have a public HTTPS address after deployment.

Important free-host limitations: the app may sleep after 15 minutes without
visitors, and the first visit after sleeping can take about a minute to load.
The service uses temporary local storage for SQLite. Accounts, books, loans,
and cover images can be permanently lost whenever the service sleeps, restarts,
or deploys. Do not use this free setup for real library records or important
data. Render Free services do not include persistent disks.

To share the source code on GitHub:
1. Create a private GitHub repository and push this project to it. Do not add
   the local SQLite database, passwords, email credentials, or setup tokens.
   The included .gitignore excludes database files, build output, and
   environment files.

The app uses a hosted PORT and secure authentication cookies when
PUBLIC_DEPLOYMENT=true is set outside Development. If deploying to a host,
configure ADMIN_SETUP_TOKEN and any mail credentials in the host's private
environment settings. Never put secrets in GitHub or this file. A deployed
database starts separately from this computer's local database; local
accounts, catalog changes, and loan records are not uploaded.

On first run, create the System Admin account with username "admin" and a
password of 10–20 characters (on a public production deployment, provide the
private admin setup token as well). New users apply from the login screen with
their name, email, username, and password. Passwords must be 10–20 characters;
application phone numbers may contain up to 11 digits. Member applications remain pending
until approved by a Librarian or System Admin. Librarian applications remain
pending until approved by a System Admin. Librarians can review and approve or
reject member applications only; System Admins can review and act on both
application types. Accounts cannot sign in until they are approved.
Member applications ask for basic contact details. Librarian applications also
ask for the library or organization, position, relevant experience, optional
work email, and an optional professional reference. The System Admin can review
these details and verify the applicant directly. Do not collect government ID
numbers or sensitive documents through the application form.

Members can browse the catalog and request available books. Requests reserve a
copy while pending and appear in the Borrow requests page for Librarians and
System Admins. A request becomes an active borrowed loan, with a 14-day due
date, only after staff approval; rejecting it releases the reserved copy.
Each title has a simulated flat rental fee in PHP for one 14-day loan, shown in the catalog,
member loan views, staff borrow requests, loan history, and the borrowing
receipt email. The fee is recorded on the loan when staff approves it, so
later price changes do not alter existing loans. This is a classroom/demo
value only: BookNest does not collect or process payments, and any face-to-face
payment happens outside the system. Renewals do not add another rental fee.
The sample catalog uses PHP 15.00 for 1984 and Pride and Prejudice, PHP 25.00
for Harry Potter, and PHP 20.00 for Foundation and A Brief History of Time;
these are sample values and can be changed from Book inventory. Overdue fines
remain separate.

Librarians and System Admins can set a title's simulated rental fee and add
physical copies from Book inventory. Adding stock increases total copies
without changing existing active loans, reserved requests, or lost/damaged
counts. New titles default to a PHP 0.00 simulated rental fee; existing titles
are migrated as PHP 0.00.
Staff can add a JPG, PNG, or WebP book cover (up to 2 MB) while creating a
title, or add, replace, and remove it later from Book inventory. The cover
editor provides a portrait crop frame that staff can drag and zoom before
saving. Covers are stored in the SQLite database and displayed throughout the
catalog; existing titles without covers continue to show a standard book
placeholder. Select a cover thumbnail to view it at a larger size. Staff book
actions are grouped under Manage book to keep the inventory table easy to scan.
Cover changes require an explicit Save cover action. Marking a copy damaged or
lost updates one eligible, unborrowed, unreserved copy at a time; restoring
also updates one copy at a time. When confirming a return, staff can confirm
normal receipt or confirm receipt and mark the loan's specific assigned copy
damaged in the same database transaction. Each physical copy has a stable Copy
# within its title; staff can identify the copy in return requests and other
condition actions. Label the physical books with their Copy # so the inventory
record can be matched to the item. Existing active loans and pending requests
receive copy numbers automatically during database migration.
Both the Librarian and System Admin dashboards show the two newest book
titles and up to six recent loan records. The Books page searches as you type
and can be filtered immediately by category or genre. Staff loan history
filters by the selected borrowing date; printing refreshes that exact filtered
date before opening the print dialog.
Members can manage their own active loans from the My loans page in the
sidebar, including requesting a return and eligible renewals. Borrowing and
return history remains a read-only records page. The member portal includes a
dashboard with current loans and borrowing/return counts, pinned books, and
account settings.
Members can update their name, email, contact number, and password.
Members, Librarians, and System Admins can upload or remove their profile
picture from the Profile page. Photos are saved separately for each account;
adjust the crop by dragging and zooming, then choose Save photo to upload it.
Use View photo to open the account's picture at full size. JPG, PNG, and WebP
images up to 2 MB are stored with the local library database and shown in the
application header.

Librarians and System Admins can archive members, and System Admins can
archive librarian accounts. Archiving requires confirmation and preserves loan
and login history. Members with active loans or pending borrow requests cannot
be archived until those are resolved. Archived accounts cannot sign in and
are hidden from active lists. System Admins can review archive activity and
restore accounts from the Archived accounts page.

Members see a due-soon alert when a loan is due within three days, and an
overdue alert after its due date. The library rule is a fine of PHP 5.00 per
calendar day after the due date, recorded when the book is returned. Staff can
monitor active due dates and estimated overdue fines from Return a book.
Members may request one 14-day renewal per loan before its due date. A Librarian
or System Admin must approve the request. Overdue loans cannot be renewed, and
renewal is blocked while another member has a pending request for the same
title.

After a borrow request is approved, the system sends a receipt to the email
address saved on that member's record (the address entered during registration).
On Render Free, configure the Brevo HTTPS API because Render blocks outbound
SMTP ports 25, 465, and 587. Create a Brevo account, verify the sender address,
then add these environment variables in the Render service's private
Environment settings:

    Email__Brevo__ApiKey = your-Brevo-API-key
    Email__Brevo__From = your-verified-sender@example.com
    Email__Brevo__SenderName = BookNest Library

Never commit or share the API key. The Brevo API key takes precedence over SMTP
when configured. After the sender and API key are set, the app sends the email
automatically when a librarian or System Admin approves a loan. If delivery
fails, BookNest shows a prepared email draft as a fallback.

Brevo's free plan has a daily sending limit; check the provider's current plan
and usage limits before relying on it. Sending still requires a verified sender
and an active provider account.

For local hosting or another host that permits SMTP, an Outlook / Microsoft
365 sender can use authenticated SMTP on port 587 with STARTTLS. Set these
environment variables in the same PowerShell window used to start the app
(replace the examples; never commit credentials):

    $env:Email__Smtp__Host = "smtp.office365.com"
    $env:Email__Smtp__Port = "587"
    $env:Email__Smtp__From = "youraddress@yourdomain.com"
    $env:Email__Smtp__Username = "youraddress@yourdomain.com"
    $env:Email__Smtp__Password = "your-mailbox-SMTP-credential"
    $env:Email__Smtp__EnableSsl = "true"
    dotnet run --project .\LibraryManagement.csproj

For a personal Outlook.com mailbox, the SMTP host is smtp-mail.outlook.com;
however, Microsoft may require OAuth2 for the account. This app's built-in SMTP
sender uses username/password authentication, not Microsoft OAuth2. For a
Microsoft 365 work/school mailbox, SMTP AUTH must be enabled for that mailbox
and allowed by the organization; use an approved SMTP credential. If the
account does not allow SMTP username/password sign-in, use Gmail SMTP instead
or configure an OAuth-based mail integration.

Gmail SMTP is also supported on hosts that allow it. Enable 2-Step Verification
on the sending Gmail account, create a Google App Password, then use
smtp.gmail.com on port 587, your Gmail address for From and Username, and the
App Password for Password. Do not use your normal Gmail password. Keep all mail
credentials private and out of source control. Restart the server after
changing environment variables.

Members appear as Online while recently active, Offline after the session stops
reporting activity, and Inactive after one year without activity. Librarians
and System Admins can see this status in the member list. Book inventory shows
Stock, Low Stock (two or fewer available copies), or Out of Stock.

Librarians and System Admins can view full member borrowing history, browse
book loan history, issue and return books, and manage library records. Staff
can filter loan history to one borrowing date and print the filtered records
from the browser's print dialog. Quick date choices include today and
yesterday, and choosing a date applies it immediately. Members see only their
own read-only history; date filtering and print controls are staff-only.
The interface uses Times New Roman throughout. System Admins can also review
librarian account status, last-seen dates, and login history.

In Book inventory, Librarians and System Admins can record available copies as
lost or damaged and restore those copies when appropriate. Copies already
borrowed or reserved cannot be marked lost or damaged. Lost and damaged copies
are excluded from availability and cannot be requested or approved for loan.

The System Admin dashboard has an overview for members and librarians, and
links to the List of Members and List of Librarians. The Applications page is
where staff review pending sign-up requests. Member and librarian roles and
account removal are managed directly from their respective lists.
