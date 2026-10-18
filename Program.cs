using System.Net.Mail;
using System.Net.Http.Json;
using System.Globalization;
using System.Security.Claims;
using System.Security.Cryptography;
using Microsoft.Data.Sqlite;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;

var builder = WebApplication.CreateBuilder(args);
var configuredPort = Environment.GetEnvironmentVariable("PORT");
var configuredUrls = Environment.GetEnvironmentVariable("ASPNETCORE_URLS");
var isHosted = (!string.IsNullOrWhiteSpace(configuredPort)
        || !string.IsNullOrWhiteSpace(configuredUrls)
        || string.Equals(Environment.GetEnvironmentVariable("PUBLIC_DEPLOYMENT"), "true", StringComparison.OrdinalIgnoreCase))
    && !builder.Environment.IsDevelopment();
var defaultUrls = isHosted
    ? $"http://0.0.0.0:{(int.TryParse(configuredPort, out var port) && port is > 0 and <= 65535 ? port : 8080)}"
    : "http://localhost:5080";
builder.WebHost.UseUrls(configuredUrls ?? defaultUrls);
builder.Services.AddSingleton<LibraryStore>();
builder.Services.AddHttpClient();
builder.Services.AddSingleton<ReceiptEmailSender>();
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.Cookie.Name = "LibraryManagement.Auth";
        options.Cookie.HttpOnly = true;
        options.Cookie.SameSite = SameSiteMode.Strict;
        options.Cookie.SecurePolicy = isHosted ? CookieSecurePolicy.Always : CookieSecurePolicy.SameAsRequest;
        options.ExpireTimeSpan = TimeSpan.FromHours(8);
        options.SlidingExpiration = true;
        options.Events.OnRedirectToLogin = context =>
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return context.Response.WriteAsJsonAsync(new { error = "Please sign in to continue." });
        };
        options.Events.OnRedirectToAccessDenied = context =>
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return context.Response.WriteAsJsonAsync(new { error = "You are not authorized to perform this action." });
        };
        options.Events.OnValidatePrincipal = context =>
        {
            var userId = context.Principal?.FindFirstValue(ClaimTypes.NameIdentifier);
            if (long.TryParse(userId, out var id)
                && context.HttpContext.RequestServices.GetRequiredService<LibraryStore>().IsUserUnavailable(id))
            {
                context.RejectPrincipal();
                return context.HttpContext.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
            }
            return Task.CompletedTask;
        };
    });
builder.Services.AddAuthorization();

var app = builder.Build();
app.UseDefaultFiles();
app.UseStaticFiles();
app.UseAuthentication();
app.UseAuthorization();

app.Use(async (context, next) =>
{
    if (context.User.Identity?.IsAuthenticated == true
        && context.User.HasClaim("must_change_password", "true")
        && context.Request.Path.StartsWithSegments("/api")
        && context.Request.Path != "/api/auth/change-password"
        && context.Request.Path != "/api/auth/me"
        && context.Request.Path != "/api/auth/logout")
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        await context.Response.WriteAsJsonAsync(new { error = "Change your temporary password before continuing." });
        return;
    }

    try
    {
        await next();
    }
    catch (InvalidOperationException ex)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        await context.Response.WriteAsJsonAsync(new { error = ex.Message });
    }
});

var api = app.MapGroup("/api");
api.MapGet("/auth/status", (LibraryStore db, IConfiguration configuration) =>
{
    var noUsers = db.UserCount() == 0;
    var setupToken = configuration["ADMIN_SETUP_TOKEN"];
    var tokenRequired = isHosted;
    var setupBlocked = noUsers && tokenRequired && string.IsNullOrWhiteSpace(setupToken);
    return Results.Ok(new
    {
        setupRequired = noUsers && !setupBlocked,
        setupRequiresToken = noUsers && tokenRequired && !setupBlocked,
        adminSetupBlocked = setupBlocked
    });
});
api.MapPost("/auth/setup", async (SetupInput input, LibraryStore db, HttpContext context, IConfiguration configuration) =>
{
    if (isHosted)
    {
        var expectedToken = configuration["ADMIN_SETUP_TOKEN"];
        if (string.IsNullOrWhiteSpace(expectedToken))
            return Results.Problem(
                "Initial admin setup is disabled until the server administrator configures ADMIN_SETUP_TOKEN.",
                statusCode: StatusCodes.Status503ServiceUnavailable);
        if (string.IsNullOrEmpty(input.SetupToken)
            || !CryptographicOperations.FixedTimeEquals(
                System.Text.Encoding.UTF8.GetBytes(expectedToken),
                System.Text.Encoding.UTF8.GetBytes(input.SetupToken)))
            return Results.Json(new { error = "The admin setup token is invalid." }, statusCode: StatusCodes.Status403Forbidden);
    }

    var user = db.CreateInitialAdmin(input.Password);
    db.RecordUserLogin(user.Id);
    await SignIn(context, user);
    return Results.Ok(new { message = "The System Admin account has been created." });
}).AllowAnonymous();
api.MapPost("/auth/apply", (AccountApplicationInput input, LibraryStore db) =>
{
    db.SubmitApplication(input);
    return Results.Ok(new { message = "Your application has been received. Wait for approval before signing in." });
}).AllowAnonymous();
api.MapPost("/auth/login", async (LoginInput input, LibraryStore db, HttpContext context) =>
{
    var user = db.Authenticate(input.Username, input.Password);
    if (user is null)
        return Results.Json(new { error = "Incorrect username or password." }, statusCode: StatusCodes.Status401Unauthorized);
    db.RecordUserLogin(user.Id);
    await SignIn(context, user);
    return Results.Ok(new { message = "Signed in successfully." });
}).AllowAnonymous();
api.MapPost("/auth/logout", async (HttpContext context) =>
{
    await context.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
    return Results.Ok(new { message = "Signed out successfully." });
}).AllowAnonymous();
api.MapGet("/auth/me", (HttpContext context) => Results.Ok(new
{
    userId = long.Parse(context.User.FindFirstValue(ClaimTypes.NameIdentifier)!),
    username = context.User.Identity?.Name,
    displayName = context.User.FindFirstValue(ClaimTypes.GivenName),
    role = context.User.FindFirstValue(ClaimTypes.Role),
    memberId = long.TryParse(context.User.FindFirstValue("member_id"), out var memberId) ? memberId : (long?)null,
    mustChangePassword = context.User.HasClaim("must_change_password", "true")
})).RequireAuthorization();
api.MapPost("/auth/change-password", async (PasswordChangeInput input, HttpContext context, LibraryStore db) =>
{
    var userId = long.Parse(context.User.FindFirstValue(ClaimTypes.NameIdentifier)!);
    if (!db.ChangePassword(userId, input.CurrentPassword, input.NewPassword))
        return Results.BadRequest(new { error = "The current password is incorrect or the new password is invalid (10–20 characters)." });

    var user = db.GetUser(userId)!;
    await SignIn(context, user);
    return Results.Ok(new { message = "Password changed successfully." });
}).RequireAuthorization();

var authenticated = api.MapGroup("").RequireAuthorization();
var staff = api.MapGroup("").RequireAuthorization(policy =>
    policy.RequireRole(AuthRoles.Librarian, AuthRoles.SystemAdmin));
authenticated.MapPost("/presence", (HttpContext context, LibraryStore db) =>
{
    db.RecordUserActivity(long.Parse(context.User.FindFirstValue(ClaimTypes.NameIdentifier)!));
    return Results.NoContent();
});
authenticated.MapGet("/auth/profile-picture", (HttpContext context, LibraryStore db) =>
{
    context.Response.Headers.CacheControl = "private, no-store, no-cache, must-revalidate";
    context.Response.Headers.Vary = "Cookie";
    var picture = db.GetProfilePicture(long.Parse(context.User.FindFirstValue(ClaimTypes.NameIdentifier)!));
    return picture is null
        ? Results.NotFound()
        : Results.File(picture.Value.Data, picture.Value.ContentType);
});
authenticated.MapPut("/auth/profile-picture", async (HttpRequest request, HttpContext context, LibraryStore db, CancellationToken cancellationToken) =>
{
    const int maxPictureSize = 2 * 1024 * 1024;
    if (request.ContentLength is > maxPictureSize)
        return Results.Json(new { error = "Profile pictures must be 2 MB or smaller." }, statusCode: StatusCodes.Status413PayloadTooLarge);

    var declaredContentType = request.ContentType?.Split(';', 2)[0].Trim().ToLowerInvariant();
    if (declaredContentType is not ("image/jpeg" or "image/png" or "image/webp"))
        return Results.BadRequest(new { error = "Choose a JPG, PNG, or WebP image." });

    await using var image = new MemoryStream();
    var buffer = new byte[16 * 1024];
    while (true)
    {
        var bytesRead = await request.Body.ReadAsync(buffer, cancellationToken);
        if (bytesRead == 0)
            break;
        if (image.Length + bytesRead > maxPictureSize)
            return Results.Json(new { error = "Profile pictures must be 2 MB or smaller." }, statusCode: StatusCodes.Status413PayloadTooLarge);
        await image.WriteAsync(buffer.AsMemory(0, bytesRead), cancellationToken);
    }

    var pictureData = image.ToArray();
    var actualContentType = GetProfilePictureContentType(pictureData);
    if (actualContentType is null || actualContentType != declaredContentType)
        return Results.BadRequest(new { error = "The image file is invalid or its format does not match the selected file type." });

    db.SaveProfilePicture(
        long.Parse(context.User.FindFirstValue(ClaimTypes.NameIdentifier)!),
        pictureData,
        actualContentType);
    return Results.NoContent();
});
authenticated.MapDelete("/auth/profile-picture", (HttpContext context, LibraryStore db) =>
{
    db.DeleteProfilePicture(long.Parse(context.User.FindFirstValue(ClaimTypes.NameIdentifier)!));
    return Results.NoContent();
});
authenticated.MapGet("/auth/profile", (HttpContext context, LibraryStore db) =>
    Results.Ok(db.GetAccountProfile(long.Parse(context.User.FindFirstValue(ClaimTypes.NameIdentifier)!))));
authenticated.MapPut("/auth/profile", async (MemberInput input, HttpContext context, LibraryStore db) =>
{
    if (!context.User.IsInRole(AuthRoles.Librarian))
        return Results.Forbid();

    var userId = long.Parse(context.User.FindFirstValue(ClaimTypes.NameIdentifier)!);
    db.UpdateLibrarianAccount(userId, input);
    await SignIn(context, db.GetUser(userId)!);
    return Results.Ok(new { message = "Account details updated." });
}).RequireAuthorization(policy => policy.RequireRole(AuthRoles.Librarian));
authenticated.MapGet("/dashboard", (HttpContext context, LibraryStore db) =>
{
    var memberId = GetMemberId(context);
    if (context.User.IsInRole(AuthRoles.Member))
        return memberId.HasValue
            ? Results.Ok(db.GetMemberDashboard(memberId.Value))
            : Results.Forbid();
    return Results.Ok(db.GetDashboard(context.User.IsInRole(AuthRoles.SystemAdmin)));
});
authenticated.MapGet("/books", (string? search, long? categoryId, long? subcategoryId, HttpContext context, LibraryStore db) =>
{
    var userId = context.User.IsInRole(AuthRoles.Member)
        ? long.Parse(context.User.FindFirstValue(ClaimTypes.NameIdentifier)!)
        : (long?)null;
    return Results.Ok(db.GetBooks(search ?? "", userId, categoryId: categoryId, subcategoryId: subcategoryId));
});
authenticated.MapGet("/books/{id:long}/cover", (long id, HttpContext context, LibraryStore db) =>
{
    context.Response.Headers.CacheControl = "private, no-store, no-cache, must-revalidate";
    context.Response.Headers.Vary = "Cookie";
    var cover = db.GetBookCover(id);
    return cover is null
        ? Results.NotFound()
        : Results.File(cover.Value.Data, cover.Value.ContentType);
});
staff.MapGet("/books/{id:long}/copies", (long id, LibraryStore db) => Results.Ok(db.GetBookCopies(id)));
authenticated.MapGet("/categories", (LibraryStore db) => Results.Ok(db.GetCategories()));
authenticated.MapGet("/books/pinned", (HttpContext context, LibraryStore db) =>
{
    if (!context.User.IsInRole(AuthRoles.Member))
        return Results.Forbid();
    return Results.Ok(db.GetPinnedBooks(long.Parse(context.User.FindFirstValue(ClaimTypes.NameIdentifier)!)));
}).RequireAuthorization(policy => policy.RequireRole(AuthRoles.Member));
authenticated.MapPost("/books/{id:long}/pin", (long id, HttpContext context, LibraryStore db) =>
{
    if (!context.User.IsInRole(AuthRoles.Member))
        return Results.Forbid();
    db.TogglePinnedBook(long.Parse(context.User.FindFirstValue(ClaimTypes.NameIdentifier)!), id);
    return Results.Ok(new { message = "Pinned books updated." });
}).RequireAuthorization(policy => policy.RequireRole(AuthRoles.Member));
authenticated.MapGet("/member/account", (HttpContext context, LibraryStore db) =>
{
    var memberId = GetMemberId(context);
    return memberId.HasValue ? Results.Ok(db.GetMemberAccount(memberId.Value)) : Results.Forbid();
}).RequireAuthorization(policy => policy.RequireRole(AuthRoles.Member));
authenticated.MapPut("/member/account", async (MemberInput input, HttpContext context, LibraryStore db) =>
{
    var memberId = GetMemberId(context);
    if (!memberId.HasValue)
        return Results.Forbid();
    db.UpdateMemberAccount(memberId.Value, input);
    var userId = long.Parse(context.User.FindFirstValue(ClaimTypes.NameIdentifier)!);
    await SignIn(context, db.GetUser(userId)!);
    return Results.Ok(new { message = "Account details updated." });
}).RequireAuthorization(policy => policy.RequireRole(AuthRoles.Member));
authenticated.MapPost("/loans/requests", (BookRequestInput request, HttpContext context, LibraryStore db) =>
{
    var memberId = GetMemberId(context);
    if (!context.User.IsInRole(AuthRoles.Member) || !memberId.HasValue)
        return Results.Forbid();
    db.RequestBook(memberId.Value, request.BookId);
    return Results.Ok(new { message = "Borrow request sent. A librarian must approve it before the book is borrowed." });
}).RequireAuthorization(policy => policy.RequireRole(AuthRoles.Member));
authenticated.MapGet("/loans/active", (HttpContext context, LibraryStore db) =>
{
    var memberId = GetMemberId(context);
    if (context.User.IsInRole(AuthRoles.Member) && !memberId.HasValue)
        return Results.Forbid();
    return Results.Ok(db.GetLoans(activeOnly: true, memberId: memberId));
});
authenticated.MapPost("/loans/{id:long}/renewals", (long id, HttpContext context, LibraryStore db) =>
{
    var memberId = GetMemberId(context);
    if (!context.User.IsInRole(AuthRoles.Member) || !memberId.HasValue)
        return Results.Forbid();
    db.RequestLoanRenewal(id, memberId.Value);
    return Results.Ok(new { message = "Renewal request sent. A librarian must approve it before the due date changes." });
}).RequireAuthorization(policy => policy.RequireRole(AuthRoles.Member));
authenticated.MapGet("/loans/history", (long? memberId, string? search, string? date, HttpContext context, LibraryStore db) =>
{
    var ownMemberId = GetMemberId(context);
    if (context.User.IsInRole(AuthRoles.Member))
        return ownMemberId.HasValue
            ? Results.Ok(db.GetLoans(memberId: ownMemberId, search: search))
            : Results.Forbid();
    if (!string.IsNullOrWhiteSpace(date)
        && !DateOnly.TryParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _))
        return Results.BadRequest(new { error = "Choose a valid history date in YYYY-MM-DD format." });
    return Results.Ok(db.GetLoans(memberId: memberId, search: search, loanDate: date));
});
authenticated.MapPost("/loans/{id:long}/return", (long id, HttpContext context, LibraryStore db) =>
{
    var memberId = GetMemberId(context);
    if (!context.User.IsInRole(AuthRoles.Member) || !memberId.HasValue)
        return Results.Forbid();
    db.RequestLoanReturn(id, memberId.Value);
    return Results.Ok(new { message = "Return request sent. The book remains borrowed until a librarian or administrator confirms that it was received." });
}).RequireAuthorization(policy => policy.RequireRole(AuthRoles.Member));

staff.MapPost("/books", async Task<IResult> (HttpRequest request, LibraryStore db, CancellationToken cancellationToken) =>
{
    const int maxRequestSize = 2 * 1024 * 1024 + 64 * 1024;
    SetMaxRequestBodySize(request, maxRequestSize);
    if (request.ContentLength is > maxRequestSize)
        return Results.Json(new { error = "Book cover uploads must be 2 MB or smaller." }, statusCode: StatusCodes.Status413PayloadTooLarge);
    BookInput book;
    byte[]? coverData = null;
    string? coverContentType = null;
    if (request.HasFormContentType)
    {
        var form = await request.ReadFormAsync(cancellationToken);
        book = BookInputFromForm(form);
        var coverFile = form.Files.GetFile("cover");
        if (coverFile is not null && !string.IsNullOrEmpty(coverFile.FileName))
        {
            const int maxCoverSize = 2 * 1024 * 1024;
            if (coverFile.Length == 0)
                return Results.BadRequest(new { error = "Choose a non-empty cover image." });
            if (coverFile.Length > maxCoverSize)
                return Results.Json(new { error = "Book covers must be 2 MB or smaller." }, statusCode: StatusCodes.Status413PayloadTooLarge);
            var declaredContentType = coverFile.ContentType.Split(';', 2)[0].Trim().ToLowerInvariant();
            if (declaredContentType is not ("image/jpeg" or "image/png" or "image/webp"))
                return Results.BadRequest(new { error = "Choose a JPG, PNG, or WebP cover image." });
            await using var image = new MemoryStream();
            await coverFile.CopyToAsync(image, cancellationToken);
            if (image.Length > maxCoverSize)
                return Results.Json(new { error = "Book covers must be 2 MB or smaller." }, statusCode: StatusCodes.Status413PayloadTooLarge);
            coverData = image.ToArray();
            coverContentType = GetProfilePictureContentType(coverData);
            if (coverContentType is null || coverContentType != declaredContentType)
                return Results.BadRequest(new { error = "The cover image is invalid or its format does not match the selected file type." });
        }
    }
    else if (request.ContentType?.StartsWith("application/json", StringComparison.OrdinalIgnoreCase) == true)
    {
        book = await request.ReadFromJsonAsync<BookInput>(cancellationToken: cancellationToken)
            ?? throw new InvalidOperationException("Enter the book details.");
    }
    else
    {
        return Results.StatusCode(StatusCodes.Status415UnsupportedMediaType);
    }

    var id = db.AddBook(book, coverData, coverContentType);
    return Results.Ok(new { id, message = "Book added successfully." });
});
staff.MapPut("/books/{id:long}/cover", async Task<IResult> (long id, HttpRequest request, LibraryStore db, CancellationToken cancellationToken) =>
{
    const int maxCoverSize = 2 * 1024 * 1024;
    SetMaxRequestBodySize(request, maxCoverSize);
    if (request.ContentLength is > maxCoverSize)
        return Results.Json(new { error = "Book covers must be 2 MB or smaller." }, statusCode: StatusCodes.Status413PayloadTooLarge);
    var declaredContentType = request.ContentType?.Split(';', 2)[0].Trim().ToLowerInvariant();
    if (declaredContentType is not ("image/jpeg" or "image/png" or "image/webp"))
        return Results.BadRequest(new { error = "Choose a JPG, PNG, or WebP cover image." });

    await using var image = new MemoryStream();
    var buffer = new byte[16 * 1024];
    while (true)
    {
        var bytesRead = await request.Body.ReadAsync(buffer, cancellationToken);
        if (bytesRead == 0)
            break;
        if (image.Length + bytesRead > maxCoverSize)
            return Results.Json(new { error = "Book covers must be 2 MB or smaller." }, statusCode: StatusCodes.Status413PayloadTooLarge);
        await image.WriteAsync(buffer.AsMemory(0, bytesRead), cancellationToken);
    }

    var coverData = image.ToArray();
    var actualContentType = GetProfilePictureContentType(coverData);
    if (actualContentType is null || actualContentType != declaredContentType)
        return Results.BadRequest(new { error = "The cover image is invalid or its format does not match the selected file type." });
    db.SaveBookCover(id, coverData, actualContentType);
    return Results.NoContent();
});
staff.MapDelete("/books/{id:long}/cover", (long id, LibraryStore db) =>
{
    db.DeleteBookCover(id);
    return Results.NoContent();
});
staff.MapPost("/books/{id:long}/stock", (long id, BookStockInput input, LibraryStore db) =>
{
    db.AddBookStock(id, input.Quantity);
    return Results.Ok(new { message = $"{input.Quantity} {(input.Quantity == 1 ? "copy" : "copies")} added to stock." });
});
staff.MapPost("/books/{id:long}/rental-fee", (long id, BookRentalFeeInput input, LibraryStore db) =>
{
    db.UpdateBookRentalFee(id, input.RentalFee);
    return Results.Ok(new { message = "Simulated rental fee updated. Existing loans keep their recorded fee." });
});
staff.MapPost("/books/{id:long}/condition", (long id, BookConditionInput input, LibraryStore db) =>
{
    db.UpdateBookCondition(id, input.Condition, input.Action, input.CopyNumber);
    var message = input.Action == "restore"
        ? $"Copy #{input.CopyNumber} restored to available inventory."
        : $"Copy #{input.CopyNumber} marked as {input.Condition?.ToLowerInvariant()}.";
    return Results.Ok(new { message });
});
staff.MapDelete("/books/{id:long}", (long id, LibraryStore db) =>
{
    db.DeleteBook(id);
    return Results.Ok(new { message = "Book deleted successfully." });
});
staff.MapGet("/members", (LibraryStore db) => Results.Ok(db.GetMembers()));
staff.MapGet("/applications", (HttpContext context, LibraryStore db) =>
    Results.Ok(db.GetApplications(context.User.IsInRole(AuthRoles.SystemAdmin))));
staff.MapPost("/applications/{id:long}/approve", (long id, HttpContext context, LibraryStore db) =>
{
    db.ApproveApplication(id, context.User.IsInRole(AuthRoles.SystemAdmin));
    return Results.Ok(new { message = "Account application approved." });
});
staff.MapPost("/applications/{id:long}/reject", (long id, HttpContext context, LibraryStore db) =>
{
    db.RejectApplication(id, context.User.IsInRole(AuthRoles.SystemAdmin));
    return Results.Ok(new { message = "Account application rejected." });
});
staff.MapPost("/members", (MemberInput member, LibraryStore db) =>
{
    db.AddMember(member);
    return Results.Ok(new { message = "Member added successfully." });
});
staff.MapDelete("/members/{id:long}", (long id, HttpContext context, LibraryStore db) =>
{
    db.ArchiveMember(id, context.User.Identity?.Name ?? "Staff");
    return Results.Ok(new { message = "Member archived. Their account is disabled, and their loan history is preserved in the System Admin archive." });
});
staff.MapGet("/loans/requests", (LibraryStore db) => Results.Ok(db.GetPendingLoanRequests()));
staff.MapGet("/loans/renewals", (LibraryStore db) => Results.Ok(db.GetPendingRenewalRequests()));
staff.MapGet("/loans/returns", (LibraryStore db) => Results.Ok(db.GetPendingReturnRequests()));
staff.MapPost("/loans/returns/{id:long}/confirm", (long id, LibraryStore db) =>
{
    var returned = db.ConfirmBookReturn(id);
    var fineMessage = returned.FineAmount > 0
        ? $" A late fine of ₱{returned.FineAmount:0.00} was recorded."
        : "";
    return Results.Ok(new { message = $"Book return confirmed.{fineMessage}", fineAmount = returned.FineAmount });
});
staff.MapPost("/loans/returns/{id:long}/confirm-damaged", (long id, LibraryStore db) =>
{
    var returned = db.ConfirmBookReturn(id, markDamaged: true);
    var fineMessage = returned.FineAmount > 0
        ? $" A late fine of ₱{returned.FineAmount:0.00} was recorded."
        : "";
    return Results.Ok(new { message = $"Book return confirmed and Copy #{returned.CopyNumber} marked damaged.{fineMessage}", fineAmount = returned.FineAmount });
});
staff.MapPost("/loans/returns/{id:long}/not-received", (long id, LibraryStore db) =>
{
    db.MarkReturnNotReceived(id);
    return Results.Ok(new { message = "Return request cleared. The book remains an active loan." });
});
staff.MapPost("/loans/renewals/{id:long}/approve", (long id, LibraryStore db) =>
{
    db.ApproveLoanRenewal(id);
    return Results.Ok(new { message = "Renewal approved. The due date has been extended by 14 days." });
});
staff.MapPost("/loans/renewals/{id:long}/reject", (long id, LibraryStore db) =>
{
    db.RejectLoanRenewal(id);
    return Results.Ok(new { message = "Renewal request rejected." });
});
staff.MapPost("/loans/requests/{id:long}/approve", async (long id, LibraryStore db, ReceiptEmailSender emailSender) =>
{
    var receipt = db.ApproveLoanRequest(id);
    var emailError = await emailSender.SendAsync(receipt);
    var message = emailError is null
    ? $"Borrow request approved. Rental fee: PHP {receipt.RentalFee:0.00}. The book is due {receipt.DueDate}; the confirmation was emailed to {receipt.MemberEmail}."
    : $"Borrow request approved. Rental fee: PHP {receipt.RentalFee:0.00}. The book is due {receipt.DueDate}; open the prepared email to {receipt.MemberEmail} and press Send.";
    return Results.Ok(new
    {
        message,
        emailSent = emailError is null,
        emailError,
        emailDraft = new
        {
            to = receipt.MemberEmail,
            subject = "Your BookNest loan is confirmed",
            body = $"""
                Good day, {receipt.MemberName},

                Your loan request has been approved, and your book loan is now confirmed.

                Book: {receipt.BookTitle}
                Borrowed: {receipt.LoanDate}
                Due date: {receipt.DueDate}
                Rental fee (14-day loan): PHP {receipt.RentalFee:0.00}

                Please return the book by the due date. Late returns incur a fine of PHP 5.00 per day.

                Thank you,
                BookNest Library
                """
        },
        receipt.DueDate
    });
});
staff.MapPost("/loans/requests/{id:long}/reject", (long id, LibraryStore db) =>
{
    db.RejectLoanRequest(id);
    return Results.Ok(new { message = "Borrow request rejected. The book is available again." });
});
var administrators = api.MapGroup("").RequireAuthorization(policy => policy.RequireRole(AuthRoles.SystemAdmin));
administrators.MapGet("/users", (LibraryStore db) => Results.Ok(db.GetUsers()));
administrators.MapGet("/users/{id:long}/history", (long id, LibraryStore db) =>
    Results.Ok(db.GetUserLoginHistory(id)));
administrators.MapGet("/archive", (LibraryStore db) => Results.Ok(db.GetAccountArchive()));
administrators.MapPost("/archive/{type}/{id:long}/restore", (string type, long id, HttpContext context, LibraryStore db) =>
{
    db.RestoreArchivedAccount(type, id, context.User.Identity?.Name ?? "System Admin");
    return Results.Ok(new { message = "Account restored and returned to the active list." });
});
administrators.MapDelete("/users/{id:long}", (long id, HttpContext context, LibraryStore db) =>
{
    db.ArchiveLibrarian(id, context.User.Identity?.Name ?? "System Admin");
    return Results.Ok(new { message = "Librarian archived. Login and account history are preserved in the System Admin archive." });
});

app.MapFallbackToFile("index.html");

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<LibraryStore>();
    db.CreateTables();
    db.SeedData();
}

app.Run();

static long? GetMemberId(HttpContext context) =>
    long.TryParse(context.User.FindFirstValue("member_id"), out var memberId) ? memberId : null;

static void SetMaxRequestBodySize(HttpRequest request, long maxRequestBodySize)
{
    var feature = request.HttpContext.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>();
    if (feature is { IsReadOnly: false })
        feature.MaxRequestBodySize = maxRequestBodySize;
}

static BookInput BookInputFromForm(IFormCollection form)
{
    if (!int.TryParse(form["publicationYear"], NumberStyles.Integer, CultureInfo.InvariantCulture, out var publicationYear)
        || !int.TryParse(form["totalCopies"], NumberStyles.Integer, CultureInfo.InvariantCulture, out var totalCopies)
        || !long.TryParse(form["categoryId"], NumberStyles.Integer, CultureInfo.InvariantCulture, out var categoryId)
        || !long.TryParse(form["subcategoryId"], NumberStyles.Integer, CultureInfo.InvariantCulture, out var subcategoryId)
        || !decimal.TryParse(form["rentalFee"], NumberStyles.Number, CultureInfo.InvariantCulture, out var rentalFee))
        throw new InvalidOperationException("Enter valid numbers for the book details.");

    return new BookInput(
        form["title"].ToString(),
        form["isbn"].ToString(),
        form["author"].ToString(),
        publicationYear,
        totalCopies,
        categoryId,
        subcategoryId,
        rentalFee);
}

static string? GetProfilePictureContentType(ReadOnlySpan<byte> image)
{
    if (image.Length >= 8
        && image[..8].SequenceEqual(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }))
        return "image/png";
    if (image.Length >= 4
        && image[0] == 0xFF && image[1] == 0xD8 && image[2] == 0xFF
        && image[^2] == 0xFF && image[^1] == 0xD9)
        return "image/jpeg";
    if (image.Length >= 12
        && image[..4].SequenceEqual("RIFF"u8)
        && image[8..12].SequenceEqual("WEBP"u8))
        return "image/webp";
    return null;
}

static async Task SignIn(HttpContext context, AuthUser user)
{
    var claims = new List<Claim>
    {
        new(ClaimTypes.NameIdentifier, user.Id.ToString()),
        new(ClaimTypes.Name, user.Username),
        new(ClaimTypes.GivenName, user.DisplayName),
        new(ClaimTypes.Role, user.Role),
        new("must_change_password", user.MustChangePassword ? "true" : "false")
    };
    if (user.MemberId.HasValue)
        claims.Add(new Claim("member_id", user.MemberId.Value.ToString()));

    await context.SignInAsync(
        CookieAuthenticationDefaults.AuthenticationScheme,
        new ClaimsPrincipal(new ClaimsIdentity(claims, CookieAuthenticationDefaults.AuthenticationScheme)));
}

internal static class AuthRoles
{
    public const string Member = "Member";
    public const string Librarian = "Librarian";
    public const string SystemAdmin = "SystemAdmin";
}

internal sealed record AuthUser(long Id, string Username, string DisplayName, string Role, long? MemberId, bool MustChangePassword);
internal sealed record SetupInput(string? Password, string? SetupToken);
internal sealed record AccountApplicationInput(
    string? Role, string? Name, string? Email, string? Phone, string? Username, string? Password,
    string? Institution, string? Position, string? WorkEmail, string? Experience, string? ProfessionalReference);
internal sealed record LoginInput(string? Username, string? Password);
internal sealed record PasswordChangeInput(string? CurrentPassword, string? NewPassword);
internal sealed record BookInput(
    string? Title,
    string? Isbn,
    string? Author,
    int PublicationYear,
    int TotalCopies,
    long CategoryId,
    long SubcategoryId,
    decimal RentalFee = 0m);

internal sealed record MemberInput(string? Name, string? Email, string? Phone);
internal sealed record BookRequestInput(long BookId);
internal sealed record BookStockInput(int Quantity);
internal sealed record BookRentalFeeInput(decimal RentalFee);
internal sealed record BookConditionInput(string? Condition, string? Action, int CopyNumber);
internal sealed record BorrowReceipt(string MemberName, string MemberEmail, string BookTitle, string LoanDate, string DueDate, decimal RentalFee);
internal sealed record ReturnedLoan(string BookTitle, string MemberName, string ReturnDate, decimal FineAmount, int OverdueDays, int CopyNumber);

internal sealed class LibraryStore
{
    private const int FinePerDayCents = 500;
    private const int LoanPeriodDays = 14;
    private readonly string _connectionString;

    public LibraryStore(IWebHostEnvironment environment)
    {
        var oldDatabase = Path.Combine(
            environment.ContentRootPath, "bin", "Debug", "net8.0-windows", "library_management.db");
        var dataFolder = Path.Combine(environment.ContentRootPath, "App_Data");
        var configuredDatabasePath = Environment.GetEnvironmentVariable("LIBRARY_DB_PATH");
        var databasePath = !string.IsNullOrWhiteSpace(configuredDatabasePath)
            ? Path.GetFullPath(configuredDatabasePath)
            : File.Exists(oldDatabase)
                ? oldDatabase
                : Path.Combine(dataFolder, "library_management.db");
        var databaseDirectory = Path.GetDirectoryName(databasePath);
        if (!string.IsNullOrWhiteSpace(databaseDirectory))
            Directory.CreateDirectory(databaseDirectory);

        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = databasePath,
            ForeignKeys = true
        }.ToString();
    }

    private SqliteConnection Open()
    {
        var connection = new SqliteConnection(_connectionString);
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA foreign_keys = ON;";
        command.ExecuteNonQuery();
        return connection;
    }

    public void CreateTables()
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            CREATE TABLE IF NOT EXISTS authors (
                author_id INTEGER PRIMARY KEY,
                name TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS categories (
                category_id INTEGER PRIMARY KEY,
                category_name TEXT NOT NULL UNIQUE
            );
            CREATE TABLE IF NOT EXISTS subcategories (
                subcategory_id INTEGER PRIMARY KEY,
                category_id INTEGER NOT NULL,
                subcategory_name TEXT NOT NULL,
                FOREIGN KEY (category_id) REFERENCES categories(category_id)
            );
            CREATE TABLE IF NOT EXISTS books (
                book_id INTEGER PRIMARY KEY,
                title TEXT NOT NULL,
                isbn TEXT NOT NULL UNIQUE,
                publication_year INTEGER,
                total_copies INTEGER NOT NULL DEFAULT 1 CHECK (total_copies > 0),
                rental_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (rental_fee_cents >= 0),
                lost_copies INTEGER NOT NULL DEFAULT 0,
                damaged_copies INTEGER NOT NULL DEFAULT 0,
                author_id INTEGER NOT NULL,
                category_id INTEGER NOT NULL,
                subcategory_id INTEGER,
                FOREIGN KEY (author_id) REFERENCES authors(author_id),
                FOREIGN KEY (category_id) REFERENCES categories(category_id),
                FOREIGN KEY (subcategory_id) REFERENCES subcategories(subcategory_id)
            );
            CREATE TABLE IF NOT EXISTS members (
                member_id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                phone TEXT,
                join_date TEXT NOT NULL,
                archived_utc TEXT,
                archived_by TEXT
            );
            CREATE TABLE IF NOT EXISTS loans (
                loan_id INTEGER PRIMARY KEY,
                member_id INTEGER NOT NULL,
                book_id INTEGER NOT NULL,
                loan_date TEXT NOT NULL,
                due_date TEXT NOT NULL,
                return_date TEXT,
                renewal_count INTEGER NOT NULL DEFAULT 0,
                fine_amount_cents INTEGER NOT NULL DEFAULT 0,
                rental_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (rental_fee_cents >= 0),
                copy_number INTEGER,
                FOREIGN KEY (member_id) REFERENCES members(member_id),
                FOREIGN KEY (book_id) REFERENCES books(book_id)
            );
            CREATE TABLE IF NOT EXISTS book_copy_conditions (
                book_id INTEGER NOT NULL,
                copy_number INTEGER NOT NULL CHECK (copy_number > 0),
                condition TEXT NOT NULL CHECK (condition IN ('Damaged','Lost')),
                PRIMARY KEY (book_id,copy_number),
                FOREIGN KEY (book_id) REFERENCES books(book_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS loan_requests (
                request_id INTEGER PRIMARY KEY,
                member_id INTEGER NOT NULL,
                book_id INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
                requested_utc TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                processed_utc TEXT,
                loan_id INTEGER,
                copy_number INTEGER,
                FOREIGN KEY (member_id) REFERENCES members(member_id),
                FOREIGN KEY (book_id) REFERENCES books(book_id),
                FOREIGN KEY (loan_id) REFERENCES loans(loan_id)
            );
            CREATE TABLE IF NOT EXISTS loan_renewal_requests (
                renewal_request_id INTEGER PRIMARY KEY,
                loan_id INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
                requested_utc TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                processed_utc TEXT,
                FOREIGN KEY (loan_id) REFERENCES loans(loan_id)
            );
            CREATE TABLE IF NOT EXISTS app_users (
                user_id INTEGER PRIMARY KEY,
                username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                password_hash TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('Member','Librarian','SystemAdmin')),
                member_id INTEGER UNIQUE,
                must_change_password INTEGER NOT NULL DEFAULT 0,
                last_seen_utc TEXT,
                created_utc TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                display_name TEXT,
                email TEXT,
                phone TEXT,
                archived_utc TEXT,
                archived_by TEXT,
                FOREIGN KEY (member_id) REFERENCES members(member_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS librarian_profiles (
                user_id INTEGER PRIMARY KEY,
                institution TEXT,
                position TEXT,
                work_email TEXT,
                experience TEXT,
                professional_reference TEXT,
                FOREIGN KEY (user_id) REFERENCES app_users(user_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS account_applications (
                application_id INTEGER PRIMARY KEY,
                role TEXT NOT NULL CHECK (role IN ('Member','Librarian')),
                name TEXT NOT NULL,
                email TEXT NOT NULL COLLATE NOCASE,
                phone TEXT,
                institution TEXT,
                position TEXT,
                work_email TEXT,
                experience TEXT,
                professional_reference TEXT,
                username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                password_hash TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                submitted_utc TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            );
            CREATE TABLE IF NOT EXISTS pinned_books (
                user_id INTEGER NOT NULL,
                book_id INTEGER NOT NULL,
                pinned_utc TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                PRIMARY KEY (user_id,book_id),
                FOREIGN KEY (user_id) REFERENCES app_users(user_id) ON DELETE CASCADE,
                FOREIGN KEY (book_id) REFERENCES books(book_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS user_login_history (
                login_id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL,
                login_utc TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES app_users(user_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS account_archive_events (
                event_id INTEGER PRIMARY KEY,
                subject_type TEXT NOT NULL CHECK (subject_type IN ('Member','Librarian')),
                subject_id INTEGER NOT NULL,
                subject_name TEXT NOT NULL,
                subject_email TEXT NOT NULL,
                action TEXT NOT NULL CHECK (action IN ('Archived','Restored')),
                actor_username TEXT NOT NULL,
                occurred_utc TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS app_settings (
                setting_key TEXT PRIMARY KEY,
                setting_value TEXT NOT NULL
            );
            """;
        command.ExecuteNonQuery();
        EnsureColumn(connection, "loans", "renewal_count", "INTEGER NOT NULL DEFAULT 0");
        EnsureColumn(connection, "loans", "fine_amount_cents", "INTEGER NOT NULL DEFAULT 0");
        EnsureColumn(connection, "loans", "return_requested_utc", "TEXT");
        EnsureColumn(connection, "loans", "rental_fee_cents", "INTEGER NOT NULL DEFAULT 0 CHECK (rental_fee_cents >= 0)");
        EnsureColumn(connection, "books", "lost_copies", "INTEGER NOT NULL DEFAULT 0");
        EnsureColumn(connection, "books", "damaged_copies", "INTEGER NOT NULL DEFAULT 0");
        EnsureColumn(connection, "books", "rental_fee_cents", "INTEGER NOT NULL DEFAULT 0 CHECK (rental_fee_cents >= 0)");
        EnsureColumn(connection, "books", "cover_image", "BLOB");
        EnsureColumn(connection, "books", "cover_image_content_type", "TEXT");
        EnsureColumn(connection, "loans", "copy_number", "INTEGER");
        EnsureColumn(connection, "loan_requests", "copy_number", "INTEGER");
        MigrateBookCopyNumbers(connection);
        using (var indexes = connection.CreateCommand())
        {
            indexes.CommandText = """
                CREATE UNIQUE INDEX IF NOT EXISTS ux_active_loan_book_copy
                    ON loans(book_id,copy_number) WHERE return_date IS NULL AND copy_number IS NOT NULL;
                CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_request_book_copy
                    ON loan_requests(book_id,copy_number) WHERE status='Pending' AND copy_number IS NOT NULL;
                """;
            indexes.ExecuteNonQuery();
        }
        EnsureColumn(connection, "app_users", "profile_picture", "BLOB");
        EnsureColumn(connection, "app_users", "profile_picture_content_type", "TEXT");
        EnsureColumn(connection, "members", "archived_utc", "TEXT");
        EnsureColumn(connection, "members", "archived_by", "TEXT");
        EnsureColumn(connection, "app_users", "archived_utc", "TEXT");
        EnsureColumn(connection, "app_users", "archived_by", "TEXT");

        var applicationColumns = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        using (var columns = connection.CreateCommand())
        {
            columns.CommandText = "PRAGMA table_info(account_applications);";
            using var columnReader = columns.ExecuteReader();
            while (columnReader.Read())
                applicationColumns.Add(columnReader.GetString(1));
        }
        foreach (var (name, type) in new[]
        {
            ("institution", "TEXT"),
            ("position", "TEXT"),
            ("work_email", "TEXT"),
            ("experience", "TEXT"),
            ("professional_reference", "TEXT")
        })
        {
            if (applicationColumns.Contains(name))
                continue;
            using var alter = connection.CreateCommand();
            alter.CommandText = $"ALTER TABLE account_applications ADD COLUMN {name} {type};";
            alter.ExecuteNonQuery();
        }

        using (var userColumns = connection.CreateCommand())
        {
            userColumns.CommandText = "PRAGMA table_info(app_users);";
            using var userReader = userColumns.ExecuteReader();
            var hasLastSeen = false;
            var hasCreatedUtc = false;
            var hasDisplayName = false;
            var hasEmail = false;
            var hasPhone = false;
            while (userReader.Read())
            {
                hasLastSeen |= userReader.GetString(1) == "last_seen_utc";
                hasCreatedUtc |= userReader.GetString(1) == "created_utc";
                hasDisplayName |= userReader.GetString(1) == "display_name";
                hasEmail |= userReader.GetString(1) == "email";
                hasPhone |= userReader.GetString(1) == "phone";
            }

            if (!hasLastSeen)
            {
                userReader.Close();
                using var alter = connection.CreateCommand();
                alter.CommandText = "ALTER TABLE app_users ADD COLUMN last_seen_utc TEXT;";
                alter.ExecuteNonQuery();
            }
            if (!hasCreatedUtc)
            {
                userReader.Close();
                using var alter = connection.CreateCommand();
                alter.CommandText = """
                    ALTER TABLE app_users ADD COLUMN created_utc TEXT;
                    UPDATE app_users SET created_utc=strftime('%Y-%m-%dT%H:%M:%fZ','now')
                    WHERE created_utc IS NULL;
                    """;
                alter.ExecuteNonQuery();
            }
            userReader.Close();
            if (!hasDisplayName)
            {
                using var alter = connection.CreateCommand();
                alter.CommandText = "ALTER TABLE app_users ADD COLUMN display_name TEXT;";
                alter.ExecuteNonQuery();
            }
            if (!hasEmail)
            {
                using var alter = connection.CreateCommand();
                alter.CommandText = "ALTER TABLE app_users ADD COLUMN email TEXT;";
                alter.ExecuteNonQuery();
            }
            if (!hasPhone)
            {
                using var alter = connection.CreateCommand();
                alter.CommandText = "ALTER TABLE app_users ADD COLUMN phone TEXT;";
                alter.ExecuteNonQuery();
            }
        }

        using var check = connection.CreateCommand();
        check.CommandText = "PRAGMA table_info(books);";
        using var reader = check.ExecuteReader();
        var hasSubcategory = false;
        var hasTotalCopies = false;
        while (reader.Read())
        {
            if (reader.GetString(1) == "subcategory_id")
                hasSubcategory = true;
            if (reader.GetString(1) == "total_copies")
                hasTotalCopies = true;
        }

        if (!hasSubcategory)
        {
            reader.Close();
            using var alter = connection.CreateCommand();
            alter.CommandText = "ALTER TABLE books ADD COLUMN subcategory_id INTEGER;";
            alter.ExecuteNonQuery();
        }

        if (!hasTotalCopies)
        {
            reader.Close();
            using var alter = connection.CreateCommand();
            alter.CommandText = """
                ALTER TABLE books ADD COLUMN total_copies INTEGER NOT NULL DEFAULT 1 CHECK (total_copies > 0);
                UPDATE books SET total_copies=CASE isbn
                    WHEN '9780451524935' THEN 4
                    WHEN '9780747532699' THEN 5
                    WHEN '9780141439518' THEN 4
                    WHEN '9780553803716' THEN 3
                    WHEN '9780553380163' THEN 4
                    ELSE 1
                END;
                """;
            alter.ExecuteNonQuery();
        }
    }

    public long UserCount() => Scalar("SELECT COUNT(*) FROM app_users WHERE archived_utc IS NULL;");

    public bool IsUserUnavailable(long userId) =>
        Scalar("""
            SELECT COUNT(*) FROM app_users u
            LEFT JOIN members m ON m.member_id=u.member_id
            WHERE u.user_id=@id
              AND u.archived_utc IS NULL
              AND (u.member_id IS NULL OR (m.member_id IS NOT NULL AND m.archived_utc IS NULL));
            """, ("@id", userId)) == 0;

    public void RecordUserActivity(long userId)
    {
        using var connection = Open();
        Execute(connection, null, "UPDATE app_users SET last_seen_utc=@seen WHERE user_id=@id;",
            ("@seen", DateTime.UtcNow.ToString("O")), ("@id", userId));
    }

    public void RecordUserLogin(long userId)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        var now = DateTime.UtcNow.ToString("O");
        Execute(connection, transaction, "UPDATE app_users SET last_seen_utc=@seen WHERE user_id=@id;",
            ("@seen", now), ("@id", userId));
        Execute(connection, transaction,
            "INSERT INTO user_login_history(user_id,login_utc) VALUES(@id,@seen);",
            ("@id", userId), ("@seen", now));
        transaction.Commit();
    }

    public AuthUser CreateInitialAdmin(string? password)
    {
        ValidatePassword(password, "password");
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        if (Scalar(connection, transaction, "SELECT COUNT(*) FROM app_users;") != 0)
            throw new InvalidOperationException("The initial admin account has already been created. Please sign in.");

        var userId = InsertUser(connection, transaction, "admin", password!, AuthRoles.SystemAdmin, null, false);
        transaction.Commit();
        return GetUser(userId)!;
    }

    public AuthUser? Authenticate(string? username, string? password)
    {
        var normalizedUsername = username?.Trim() ?? "";
        if (normalizedUsername.Length == 0 || string.IsNullOrEmpty(password))
            return null;

        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT u.user_id,u.username,u.password_hash,u.password_salt,u.role,u.member_id,
                   u.must_change_password,COALESCE(m.name,u.display_name,u.username)
            FROM app_users u LEFT JOIN members m ON m.member_id=u.member_id
            WHERE u.username=@username COLLATE NOCASE
              AND u.archived_utc IS NULL AND (m.archived_utc IS NULL OR u.member_id IS NULL);
            """;
        command.Parameters.AddWithValue("@username", normalizedUsername);
        using var reader = command.ExecuteReader();
        if (!reader.Read()
            || !VerifyPassword(password, reader.GetString(2), reader.GetString(3)))
            return null;

        return new AuthUser(
            reader.GetInt64(0), reader.GetString(1), reader.GetString(7), reader.GetString(4),
            reader.IsDBNull(5) ? null : reader.GetInt64(5), reader.GetInt64(6) != 0);
    }

    public AuthUser? GetUser(long userId)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT u.user_id,u.username,COALESCE(m.name,u.display_name,u.username),u.role,u.member_id,u.must_change_password
            FROM app_users u LEFT JOIN members m ON m.member_id=u.member_id
            WHERE u.user_id=@id
              AND u.archived_utc IS NULL AND (m.archived_utc IS NULL OR u.member_id IS NULL);
            """;
        command.Parameters.AddWithValue("@id", userId);
        using var reader = command.ExecuteReader();
        return reader.Read()
            ? new AuthUser(reader.GetInt64(0), reader.GetString(1), reader.GetString(2), reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetInt64(4), reader.GetInt64(5) != 0)
            : null;
    }

    public object GetAccountProfile(long userId)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT u.username,u.role,
                   CASE WHEN u.role=@member THEN m.name ELSE u.display_name END,
                   CASE WHEN u.role=@member THEN m.email ELSE u.email END,
                   CASE WHEN u.role=@member THEN m.phone ELSE u.phone END,
                   lp.institution,lp.position,lp.work_email,lp.experience,lp.professional_reference,
                   u.profile_picture IS NOT NULL
            FROM app_users u
            LEFT JOIN members m ON m.member_id=u.member_id
            LEFT JOIN librarian_profiles lp ON lp.user_id=u.user_id
            WHERE u.user_id=@id;
            """;
        command.Parameters.AddWithValue("@id", userId);
        command.Parameters.AddWithValue("@member", AuthRoles.Member);
        using var reader = command.ExecuteReader();
        if (!reader.Read())
            throw new InvalidOperationException("Account profile not found.");
        return new
        {
            username = reader.GetString(0),
            role = reader.GetString(1),
            name = reader.IsDBNull(2) ? null : reader.GetString(2),
            email = reader.IsDBNull(3) ? null : reader.GetString(3),
            phone = reader.IsDBNull(4) ? null : reader.GetString(4),
            institution = reader.IsDBNull(5) ? null : reader.GetString(5),
            position = reader.IsDBNull(6) ? null : reader.GetString(6),
            workEmail = reader.IsDBNull(7) ? null : reader.GetString(7),
            experience = reader.IsDBNull(8) ? null : reader.GetString(8),
            professionalReference = reader.IsDBNull(9) ? null : reader.GetString(9),
            hasProfilePicture = reader.GetBoolean(10)
        };
    }

    public (byte[] Data, string ContentType)? GetProfilePicture(long userId)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT profile_picture,profile_picture_content_type
            FROM app_users
            WHERE user_id=@id AND profile_picture IS NOT NULL;
            """;
        command.Parameters.AddWithValue("@id", userId);
        using var reader = command.ExecuteReader();
        if (!reader.Read())
            return null;
        return (reader.GetFieldValue<byte[]>(0), reader.GetString(1));
    }

    public void SaveProfilePicture(long userId, byte[] data, string contentType)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE app_users
            SET profile_picture=@picture,profile_picture_content_type=@contentType
            WHERE user_id=@id;
            """;
        command.Parameters.AddWithValue("@picture", data);
        command.Parameters.AddWithValue("@contentType", contentType);
        command.Parameters.AddWithValue("@id", userId);
        if (command.ExecuteNonQuery() == 0)
            throw new InvalidOperationException("Account not found.");
    }

    public void DeleteProfilePicture(long userId)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE app_users
            SET profile_picture=NULL,profile_picture_content_type=NULL
            WHERE user_id=@id;
            """;
        command.Parameters.AddWithValue("@id", userId);
        if (command.ExecuteNonQuery() == 0)
            throw new InvalidOperationException("Account not found.");
    }

    public bool ChangePassword(long userId, string? currentPassword, string? newPassword)
    {
        if (string.IsNullOrEmpty(currentPassword) || !IsValidPassword(newPassword))
            return false;

        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT password_hash,password_salt FROM app_users WHERE user_id=@id;";
        command.Parameters.AddWithValue("@id", userId);
        using var reader = command.ExecuteReader();
        if (!reader.Read())
            return false;
        var currentHash = reader.GetString(0);
        var currentSalt = reader.GetString(1);
        reader.Close();
        if (!VerifyPassword(currentPassword, currentHash, currentSalt))
            return false;

        var (hash, salt) = HashPassword(newPassword!);
        using var update = connection.CreateCommand();
        update.CommandText = """
            UPDATE app_users SET password_hash=@hash,password_salt=@salt,must_change_password=0
            WHERE user_id=@id;
            """;
        update.Parameters.AddWithValue("@hash", hash);
        update.Parameters.AddWithValue("@salt", salt);
        update.Parameters.AddWithValue("@id", userId);
        return update.ExecuteNonQuery() == 1;
    }

    public IReadOnlyList<object> GetUsers()
    {
        var users = new List<object>();
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT u.user_id,u.username,u.role,COALESCE(m.name,u.display_name,u.username),u.member_id,u.must_change_password,
                   u.last_seen_utc,u.created_utc,COALESCE(m.email,u.email,''),COALESCE(m.phone,u.phone,'')
            FROM app_users u LEFT JOIN members m ON m.member_id=u.member_id
            WHERE u.archived_utc IS NULL AND (u.member_id IS NULL OR m.archived_utc IS NULL)
            ORDER BY u.role,u.username COLLATE NOCASE;
            """;
        using var reader = command.ExecuteReader();
        while (reader.Read())
            users.Add(new
            {
                id = reader.GetInt64(0),
                username = reader.GetString(1),
                role = reader.GetString(2),
                displayName = reader.GetString(3),
                memberId = reader.IsDBNull(4) ? (long?)null : reader.GetInt64(4),
                mustChangePassword = reader.GetInt64(5) != 0,
                lastSeen = reader.IsDBNull(6) ? null : reader.GetString(6),
                status = GetPresenceStatus(
                    reader.IsDBNull(6) ? null : reader.GetString(6),
                    reader.IsDBNull(7) ? null : reader.GetString(7)),
                email = reader.GetString(8),
                phone = reader.GetString(9)
            });
        return users;
    }

    public object GetAccountArchive()
    {
        var accounts = new List<object>();
        using (var connection = Open())
        using (var command = connection.CreateCommand())
        {
            command.CommandText = """
                SELECT 'Member',m.member_id,m.name,m.email,m.archived_utc,COALESCE(m.archived_by,'Unknown'),
                       COUNT(l.loan_id),COALESCE(SUM(CASE WHEN l.return_date IS NULL THEN 1 ELSE 0 END),0)
                FROM members m LEFT JOIN loans l ON l.member_id=m.member_id
                WHERE m.archived_utc IS NOT NULL
                GROUP BY m.member_id,m.name,m.email,m.archived_utc,m.archived_by
                UNION ALL
                SELECT 'Librarian',u.user_id,COALESCE(u.display_name,u.username),COALESCE(u.email,''),
                       u.archived_utc,COALESCE(u.archived_by,'Unknown'),0,0
                FROM app_users u WHERE u.role=@librarian AND u.archived_utc IS NOT NULL
                ORDER BY 5 DESC;
                """;
            command.Parameters.AddWithValue("@librarian", AuthRoles.Librarian);
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                accounts.Add(new
                {
                    type = reader.GetString(0),
                    id = reader.GetInt64(1),
                    name = reader.GetString(2),
                    email = reader.GetString(3),
                    archivedAt = reader.GetString(4),
                    archivedBy = reader.GetString(5),
                    loanRecords = reader.GetInt32(6),
                    activeLoans = reader.GetInt32(7)
                });
            }
        }

        var activity = new List<object>();
        using (var connection = Open())
        using (var command = connection.CreateCommand())
        {
            command.CommandText = """
                SELECT event_id,subject_type,subject_name,subject_email,action,actor_username,occurred_utc
                FROM account_archive_events
                ORDER BY event_id DESC
                LIMIT 200;
                """;
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                activity.Add(new
                {
                    id = reader.GetInt64(0),
                    type = reader.GetString(1),
                    name = reader.GetString(2),
                    email = reader.GetString(3),
                    action = reader.GetString(4),
                    actor = reader.GetString(5),
                    occurredAt = reader.GetString(6)
                });
            }
        }

        return new { accounts, activity };
    }

    public void ArchiveMember(long memberId, string actor)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = """
                SELECT name,email FROM members WHERE member_id=@id AND archived_utc IS NULL;
                """;
            command.Parameters.AddWithValue("@id", memberId);
            using var reader = command.ExecuteReader();
            if (!reader.Read())
                throw new InvalidOperationException("Active member not found.");
        }

        if (Scalar(connection, transaction,
                "SELECT COUNT(*) FROM loans WHERE member_id=@id AND return_date IS NULL;",
                ("@id", memberId)) > 0)
            throw new InvalidOperationException("Return or confirm all active loans before archiving this member.");
        if (Scalar(connection, transaction,
                "SELECT COUNT(*) FROM loan_requests WHERE member_id=@id AND status='Pending';",
                ("@id", memberId)) > 0)
            throw new InvalidOperationException("Approve or reject this member's pending borrow requests before archiving.");

        var archivedAt = DateTime.UtcNow.ToString("O");
        Execute(connection, transaction, """
            UPDATE members SET archived_utc=@archivedAt,archived_by=@actor
            WHERE member_id=@id AND archived_utc IS NULL;
            """, ("@archivedAt", archivedAt), ("@actor", actor), ("@id", memberId));
        Execute(connection, transaction, """
            UPDATE app_users SET archived_utc=@archivedAt,archived_by=@actor
            WHERE member_id=@id AND archived_utc IS NULL;
            """, ("@archivedAt", archivedAt), ("@actor", actor), ("@id", memberId));
        Execute(connection, transaction, """
            INSERT INTO account_archive_events(subject_type,subject_id,subject_name,subject_email,action,actor_username,occurred_utc)
            SELECT 'Member',member_id,name,email,'Archived',@actor,@archivedAt
            FROM members WHERE member_id=@id;
            """, ("@actor", actor), ("@archivedAt", archivedAt), ("@id", memberId));
        transaction.Commit();
    }

    public void ArchiveLibrarian(long userId, string actor)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = """
                SELECT COALESCE(display_name,username),COALESCE(email,'')
                FROM app_users
                WHERE user_id=@id AND role=@role AND archived_utc IS NULL;
                """;
            command.Parameters.AddWithValue("@id", userId);
            command.Parameters.AddWithValue("@role", AuthRoles.Librarian);
            using var reader = command.ExecuteReader();
            if (!reader.Read())
                throw new InvalidOperationException("Active librarian account not found.");
        }

        var archivedAt = DateTime.UtcNow.ToString("O");
        Execute(connection, transaction, """
            UPDATE app_users SET archived_utc=@archivedAt,archived_by=@actor
            WHERE user_id=@id AND role=@role AND archived_utc IS NULL;
            """, ("@archivedAt", archivedAt), ("@actor", actor), ("@id", userId), ("@role", AuthRoles.Librarian));
        Execute(connection, transaction, """
            INSERT INTO account_archive_events(subject_type,subject_id,subject_name,subject_email,action,actor_username,occurred_utc)
            SELECT 'Librarian',user_id,COALESCE(display_name,username),COALESCE(email,''),'Archived',@actor,@archivedAt
            FROM app_users WHERE user_id=@id;
            """, ("@actor", actor), ("@archivedAt", archivedAt), ("@id", userId));
        transaction.Commit();
    }

    public void RestoreArchivedAccount(string type, long id, string actor)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        string name;
        string email;
        switch (type)
        {
            case "Member":
                break;
            case "Librarian":
                break;
            default:
                throw new InvalidOperationException("Unknown archived account type.");
        }

        using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = type == "Member"
                ? "SELECT name,email FROM members WHERE member_id=@id AND archived_utc IS NOT NULL;"
                : "SELECT COALESCE(display_name,username),COALESCE(email,'') FROM app_users WHERE user_id=@id AND role=@role AND archived_utc IS NOT NULL;";
            command.Parameters.AddWithValue("@id", id);
            if (type == "Librarian")
                command.Parameters.AddWithValue("@role", AuthRoles.Librarian);
            using var reader = command.ExecuteReader();
            if (!reader.Read())
                throw new InvalidOperationException("Archived account not found.");
            name = reader.GetString(0);
            email = reader.GetString(1);
        }

        if (type == "Member")
        {
            Execute(connection, transaction, """
                UPDATE members SET archived_utc=NULL,archived_by=NULL WHERE member_id=@id;
                """, ("@id", id));
            Execute(connection, transaction, """
                UPDATE app_users SET archived_utc=NULL,archived_by=NULL WHERE member_id=@id;
                """, ("@id", id));
        }
        else
        {
            Execute(connection, transaction, """
                UPDATE app_users SET archived_utc=NULL,archived_by=NULL
                WHERE user_id=@id AND role=@role;
                """, ("@id", id), ("@role", AuthRoles.Librarian));
        }

        Execute(connection, transaction, """
            INSERT INTO account_archive_events(subject_type,subject_id,subject_name,subject_email,action,actor_username,occurred_utc)
            VALUES(@type,@id,@name,@email,'Restored',@actor,@occurredAt);
            """, ("@type", type), ("@id", id), ("@name", name), ("@email", email),
            ("@actor", actor), ("@occurredAt", DateTime.UtcNow.ToString("O")));
        transaction.Commit();
    }

    public IReadOnlyList<object> GetUserLoginHistory(long userId)
    {
        var history = new List<object>();
        using var connection = Open();
        if (Scalar(connection, null, "SELECT COUNT(*) FROM app_users WHERE user_id=@id;", ("@id", userId)) == 0)
            throw new InvalidOperationException("User account not found.");
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT login_utc FROM user_login_history
            WHERE user_id=@id ORDER BY login_id DESC LIMIT 100;
            """;
        command.Parameters.AddWithValue("@id", userId);
        using var reader = command.ExecuteReader();
        while (reader.Read())
            history.Add(new { loginAt = reader.GetString(0) });
        return history;
    }

    public object GetMemberAccount(long memberId)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT m.name,m.email,COALESCE(m.phone,''),u.username
            FROM members m JOIN app_users u ON u.member_id=m.member_id
            WHERE m.member_id=@id;
            """;
        command.Parameters.AddWithValue("@id", memberId);
        using var reader = command.ExecuteReader();
        if (!reader.Read())
            throw new InvalidOperationException("Member account not found.");
        return new
        {
            name = reader.GetString(0),
            email = reader.GetString(1),
            phone = reader.GetString(2),
            username = reader.GetString(3)
        };
    }

    public void UpdateMemberAccount(long memberId, MemberInput input)
    {
        var name = Required(input.Name, "Enter the member's name.", 120);
        var email = Required(input.Email, "Enter an email address.", 254);
        try
        {
            if (new MailAddress(email).Address != email)
                throw new FormatException();
        }
        catch (FormatException)
        {
            throw new InvalidOperationException("Enter a valid email address.");
        }
        if (input.Phone?.Trim().Length > 40)
            throw new InvalidOperationException("Phone number cannot exceed 40 characters.");

        using var connection = Open();
        if (Scalar(connection, null, """
            SELECT COUNT(*) FROM members WHERE email=@email COLLATE NOCASE AND member_id<>@id;
            """, ("@email", email), ("@id", memberId)) != 0)
            throw new InvalidOperationException("Another member is already using that email address.");
        if (Execute(connection, null, """
            UPDATE members SET name=@name,email=@email,phone=@phone WHERE member_id=@id;
            """, ("@name", name), ("@email", email),
            ("@phone", string.IsNullOrWhiteSpace(input.Phone) ? null : input.Phone.Trim()),
            ("@id", memberId)) == 0)
            throw new InvalidOperationException("Member account not found.");
    }

    public void UpdateLibrarianAccount(long userId, MemberInput input)
    {
        var name = Required(input.Name, "Enter your full name.", 120);
        var email = Required(input.Email, "Enter an email address.", 254);
        try
        {
            if (new MailAddress(email).Address != email)
                throw new FormatException();
        }
        catch (FormatException)
        {
            throw new InvalidOperationException("Enter a valid email address.");
        }
        if (input.Phone?.Trim().Length > 40)
            throw new InvalidOperationException("Phone number cannot exceed 40 characters.");

        using var connection = Open();
        if (Execute(connection, null, """
            UPDATE app_users SET display_name=@name,email=@email,phone=@phone
            WHERE user_id=@id AND role=@role;
            """, ("@name", name), ("@email", email),
            ("@phone", string.IsNullOrWhiteSpace(input.Phone) ? null : input.Phone.Trim()),
            ("@id", userId), ("@role", AuthRoles.Librarian)) == 0)
            throw new InvalidOperationException("Librarian account not found.");
    }

    public void SubmitApplication(AccountApplicationInput input)
    {
        var role = input.Role?.Trim();
        if (role is not (AuthRoles.Member or AuthRoles.Librarian))
            throw new InvalidOperationException("Select a valid account type.");

        var name = Required(input.Name, "Enter your full name.", 120);
        var email = Required(input.Email, "Enter an email address.", 254);
        try
        {
            if (new MailAddress(email).Address != email)
                throw new FormatException();
        }
        catch (FormatException)
        {
            throw new InvalidOperationException("Enter a valid email address.");
        }
        var phone = string.IsNullOrWhiteSpace(input.Phone) ? null : input.Phone.Trim();
        if (phone is not null
            && (phone.Length > 11 || phone.Any(character => !char.IsAsciiDigit(character))))
            throw new InvalidOperationException("Phone number must contain digits only and cannot exceed 11 digits.");
        var institution = role == AuthRoles.Librarian
            ? Required(input.Institution, "Enter the library or organization name.", 180)
            : null;
        var position = role == AuthRoles.Librarian
            ? Required(input.Position, "Enter the position you are applying for.", 120)
            : null;
        var experience = role == AuthRoles.Librarian
            ? Required(input.Experience, "Describe your relevant library experience.", 2000)
            : null;
        var workEmail = string.IsNullOrWhiteSpace(input.WorkEmail) ? null : input.WorkEmail.Trim();
        if (workEmail is not null)
        {
            if (workEmail.Length > 254)
                throw new InvalidOperationException("Work email cannot exceed 254 characters.");
            try
            {
                if (new MailAddress(workEmail).Address != workEmail)
                    throw new FormatException();
            }
            catch (FormatException)
            {
                throw new InvalidOperationException("Enter a valid work email address.");
            }
        }
        var professionalReference = string.IsNullOrWhiteSpace(input.ProfessionalReference)
            ? null
            : Required(input.ProfessionalReference, "Enter a valid professional reference.", 180);
        var username = ValidateUsername(input.Username);
        ValidatePassword(input.Password, "password");

        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        EnsureUsernameAvailable(connection, transaction, username, null);
        if (role == AuthRoles.Member)
        {
            if (Scalar(connection, transaction, """
                SELECT COUNT(*) FROM account_applications WHERE role=@role AND email=@email COLLATE NOCASE;
                """, ("@role", AuthRoles.Member), ("@email", email)) != 0)
                throw new InvalidOperationException("A pending member application is already using that email address.");
            if (Scalar(connection, transaction, """
                SELECT COUNT(*) FROM app_users u JOIN members m ON m.member_id=u.member_id
                WHERE u.role=@role AND m.email=@email COLLATE NOCASE;
                """, ("@role", AuthRoles.Member), ("@email", email)) != 0)
                throw new InvalidOperationException("A member account is already using that email address.");
        }

        var (hash, salt) = HashPassword(input.Password!);
        Execute(connection, transaction, """
            INSERT INTO account_applications(role,name,email,phone,institution,position,work_email,
                                             experience,professional_reference,username,password_hash,password_salt)
            VALUES(@role,@name,@email,@phone,@institution,@position,@workEmail,
                   @experience,@reference,@username,@hash,@salt);
            """, ("@role", role), ("@name", name), ("@email", email),
            ("@phone", phone),
            ("@institution", institution), ("@position", position), ("@workEmail", workEmail),
            ("@experience", experience), ("@reference", professionalReference),
            ("@username", username), ("@hash", hash), ("@salt", salt));
        transaction.Commit();
    }

    public IReadOnlyList<object> GetApplications(bool includeLibrarians)
    {
        var applications = new List<object>();
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT application_id,role,name,email,COALESCE(phone,''),username,submitted_utc,
                   COALESCE(institution,''),COALESCE(position,''),COALESCE(work_email,''),
                   COALESCE(experience,''),COALESCE(professional_reference,'')
            FROM account_applications
            WHERE @includeLibrarians=1 OR role=@member
            ORDER BY submitted_utc,application_id;
            """;
        command.Parameters.AddWithValue("@includeLibrarians", includeLibrarians ? 1 : 0);
        command.Parameters.AddWithValue("@member", AuthRoles.Member);
        using var reader = command.ExecuteReader();
        while (reader.Read())
            applications.Add(new
            {
                id = reader.GetInt64(0),
                role = reader.GetString(1),
                name = reader.GetString(2),
                email = reader.GetString(3),
                phone = reader.GetString(4),
                username = reader.GetString(5),
                submittedAt = reader.GetString(6),
                institution = reader.GetString(7),
                position = reader.GetString(8),
                workEmail = reader.GetString(9),
                experience = reader.GetString(10),
                professionalReference = reader.GetString(11)
            });
        return applications;
    }

    public void ApproveApplication(long applicationId, bool isSystemAdmin)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            SELECT role,name,email,phone,username,password_hash,password_salt,
                   institution,position,work_email,experience,professional_reference
            FROM account_applications WHERE application_id=@id;
            """;
        command.Parameters.AddWithValue("@id", applicationId);
        using var reader = command.ExecuteReader();
        if (!reader.Read())
            throw new InvalidOperationException("Pending application not found.");
        var role = reader.GetString(0);
        var name = reader.GetString(1);
        var email = reader.GetString(2);
        var phone = reader.IsDBNull(3) ? null : reader.GetString(3);
        var username = reader.GetString(4);
        var hash = reader.GetString(5);
        var salt = reader.GetString(6);
        var institution = reader.IsDBNull(7) ? null : reader.GetString(7);
        var position = reader.IsDBNull(8) ? null : reader.GetString(8);
        var workEmail = reader.IsDBNull(9) ? null : reader.GetString(9);
        var experience = reader.IsDBNull(10) ? null : reader.GetString(10);
        var professionalReference = reader.IsDBNull(11) ? null : reader.GetString(11);
        reader.Close();

        if (!isSystemAdmin && role != AuthRoles.Member)
            throw new InvalidOperationException("Only the System Admin can approve librarian applications.");

        long? memberId = null;
        if (role == AuthRoles.Member)
        {
            memberId = Scalar(connection, transaction,
                "SELECT COALESCE((SELECT member_id FROM members WHERE email=@email COLLATE NOCASE),0);",
                ("@email", email));
            if (memberId == 0)
            {
                Execute(connection, transaction, """
                    INSERT INTO members(name,email,phone,join_date) VALUES(@name,@email,@phone,@date);
                    """, ("@name", name), ("@email", email), ("@phone", phone),
                    ("@date", DateTime.Today.ToString("yyyy-MM-dd")));
                memberId = Scalar(connection, transaction, "SELECT last_insert_rowid();");
            }
            else
            {
                if (Scalar(connection, transaction, "SELECT COUNT(*) FROM app_users WHERE member_id=@id;",
                        ("@id", memberId)) != 0)
                    throw new InvalidOperationException("This member already has an active account.");
                Execute(connection, transaction, """
                    UPDATE members SET name=@name,phone=@phone WHERE member_id=@id;
                    """, ("@name", name), ("@phone", phone), ("@id", memberId));
            }
        }

        Execute(connection, transaction, """
            INSERT INTO app_users(username,password_hash,password_salt,role,member_id,must_change_password,
                                  display_name,email,phone)
            VALUES(@username,@hash,@salt,@role,@member,0,@name,@email,@phone);
            """, ("@username", username), ("@hash", hash), ("@salt", salt), ("@role", role),
            ("@member", memberId), ("@name", name), ("@email", email), ("@phone", phone));
        if (role == AuthRoles.Librarian)
        {
            var userId = Scalar(connection, transaction, "SELECT last_insert_rowid();");
            Execute(connection, transaction, """
                INSERT INTO librarian_profiles(user_id,institution,position,work_email,experience,professional_reference)
                VALUES(@userId,@institution,@position,@workEmail,@experience,@reference);
                """, ("@userId", userId), ("@institution", institution), ("@position", position),
                ("@workEmail", workEmail), ("@experience", experience), ("@reference", professionalReference));
        }
        Execute(connection, transaction,
            "DELETE FROM account_applications WHERE application_id=@id;", ("@id", applicationId));
        transaction.Commit();
    }

    public void RejectApplication(long applicationId, bool isSystemAdmin)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        var role = Scalar(connection, transaction,
            "SELECT COUNT(*) FROM account_applications WHERE application_id=@id AND role=@librarian;",
            ("@id", applicationId), ("@librarian", AuthRoles.Librarian));
        if (!isSystemAdmin && role != 0)
            throw new InvalidOperationException("Only the System Admin can reject librarian applications.");
        if (Execute(connection, transaction,
                "DELETE FROM account_applications WHERE application_id=@id;", ("@id", applicationId)) == 0)
            throw new InvalidOperationException("Pending application not found.");
        transaction.Commit();
    }

    private static long InsertUser(
        SqliteConnection connection, SqliteTransaction transaction, string username, string password,
        string role, long? memberId, bool mustChangePassword)
    {
        var (hash, salt) = HashPassword(password);
        Execute(connection, transaction, """
            INSERT INTO app_users(username,password_hash,password_salt,role,member_id,must_change_password)
            VALUES(@username,@hash,@salt,@role,@member,@mustChange);
            """, ("@username", username), ("@hash", hash), ("@salt", salt), ("@role", role),
            ("@member", memberId), ("@mustChange", mustChangePassword ? 1 : 0));
        return Scalar(connection, transaction, "SELECT last_insert_rowid();");
    }

    private static void EnsureUsernameAvailable(
        SqliteConnection connection, SqliteTransaction transaction, string username, long? exceptUserId)
    {
        if (Scalar(connection, transaction, """
            SELECT (SELECT COUNT(*) FROM app_users
                    WHERE username=@username COLLATE NOCASE AND (@exceptId IS NULL OR user_id<>@exceptId))
                 + (SELECT COUNT(*) FROM account_applications WHERE username=@username COLLATE NOCASE);
            """, ("@username", username), ("@exceptId", exceptUserId)) != 0)
            throw new InvalidOperationException("That username is already in use.");
    }

    private static string ValidateUsername(string? username)
    {
        var value = username?.Trim() ?? "";
        if (value.Length is < 3 or > 32
            || value.Any(character => !(char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or '-')))
            throw new InvalidOperationException("Username must be 3–32 characters and contain only letters, numbers, periods, underscores, or hyphens.");
        return value;
    }

    private static void ValidatePassword(string? password, string fieldName)
    {
        if (!IsValidPassword(password))
            throw new InvalidOperationException($"The {fieldName} must be 10–20 characters.");
    }

    private static bool IsValidPassword(string? password) => password is { Length: >= 10 and <= 20 };

    private static (string Hash, string Salt) HashPassword(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var hash = Rfc2898DeriveBytes.Pbkdf2(password, salt, 210_000, HashAlgorithmName.SHA256, 32);
        return (Convert.ToBase64String(hash), Convert.ToBase64String(salt));
    }

    private static bool VerifyPassword(string password, string hash, string salt)
    {
        var actual = Rfc2898DeriveBytes.Pbkdf2(
            password, Convert.FromBase64String(salt), 210_000, HashAlgorithmName.SHA256, 32);
        return CryptographicOperations.FixedTimeEquals(actual, Convert.FromBase64String(hash));
    }

    public void SeedData()
    {
        var taxonomy = new Dictionary<string, string[]>
        {
            ["Fiction"] = ["Fantasy", "Science Fiction", "Mystery", "Thriller", "Horror", "Romance", "Adventure", "Historical Fiction", "Literary Fiction"],
            ["Nonfiction"] = ["Self-Help", "Biography", "Autobiography", "History", "Philosophy", "Psychology", "Politics"],
            ["Science"] = ["Biology", "Chemistry", "Physics", "Astronomy", "Earth Science"],
            ["Technology"] = ["Computer Science", "Programming", "Artificial Intelligence", "Networking", "Cybersecurity", "Electronics"],
            ["Education"] = ["Mathematics", "Engineering", "Education", "Language", "Teaching"],
            ["Business"] = ["Accounting", "Finance", "Marketing", "Management", "Entrepreneurship", "Economics"],
            ["Health"] = ["Medicine", "Nursing", "Nutrition", "Fitness", "Mental Wellness"],
            ["Arts & Literature"] = ["Poetry", "Drama", "Art", "Music", "Literature", "Photography"],
            ["Social Sciences"] = ["Sociology", "Anthropology", "Geography", "Political Science"],
            ["Religion"] = ["Christianity", "Islam", "Buddhism", "Hinduism", "Comparative Religion"],
            ["Children's Books"] = ["Picture Books", "Fairy Tales", "Early Readers", "Educational Stories"],
            ["Reference"] = ["Dictionary", "Encyclopedia", "Atlas", "Almanac", "Handbook"],
            ["Travel"] = ["Travel Guide", "Tourism", "Adventure Travel", "Culture"]
        };

        using var connection = Open();
        using var transaction = connection.BeginTransaction();

        foreach (var (categoryName, subcategoryNames) in taxonomy)
        {
            Execute(connection, transaction,
                "INSERT OR IGNORE INTO categories(category_name) VALUES(@name);",
                ("@name", categoryName));
            var categoryId = Scalar(connection, transaction,
                "SELECT category_id FROM categories WHERE category_name=@name;",
                ("@name", categoryName));

            foreach (var name in subcategoryNames)
            {
                Execute(connection, transaction, """
                    INSERT INTO subcategories(category_id,subcategory_name)
                    SELECT @category,@name
                    WHERE NOT EXISTS(
                        SELECT 1 FROM subcategories WHERE category_id=@category AND subcategory_name=@name);
                    """, ("@category", categoryId), ("@name", name));
            }
        }

        if (Scalar(connection, transaction, "SELECT COUNT(*) FROM authors;") == 0)
        {
            var authors = new[] { "George Orwell", "J.K. Rowling", "Jane Austen", "Isaac Asimov", "Stephen Hawking" };
            foreach (var name in authors)
                Execute(connection, transaction, "INSERT INTO authors(name) VALUES(@name);", ("@name", name));

            AddSampleBook(connection, transaction, "1984", "9780451524935", 1949, 1, "Fiction", "Mystery", 4, 15m);
            AddSampleBook(connection, transaction, "Harry Potter and the Philosopher's Stone", "9780747532699", 1997, 2, "Fiction", "Fantasy", 5, 25m);
            AddSampleBook(connection, transaction, "Pride and Prejudice", "9780141439518", 1813, 3, "Fiction", "Romance", 4, 15m);
            AddSampleBook(connection, transaction, "Foundation", "9780553803716", 1951, 4, "Fiction", "Science Fiction", 3, 20m);
            AddSampleBook(connection, transaction, "A Brief History of Time", "9780553380163", 1988, 5, "Nonfiction", "History", 4, 20m);

            Execute(connection, transaction, """
                INSERT INTO members(name,email,phone,join_date) VALUES
                    ('Aisha Khan','aisha@example.com','555-1010','2026-08-01'),
                    ('Mateo Silva','mateo@example.com','555-2020','2026-08-04');
                """);
            Execute(connection, transaction, """
                INSERT INTO loans(member_id,book_id,loan_date,due_date,return_date) VALUES
                    (1,1,'2026-08-05','2026-08-19',NULL),
                    (2,3,'2026-08-06','2026-08-20','2026-08-15');
                """);
        }

        if (Scalar(connection, transaction,
                "SELECT COUNT(*) FROM app_settings WHERE setting_key=@key;",
                ("@key", "seeded-rental-fees-v1")) == 0)
        {
            Execute(connection, transaction, """
                UPDATE books SET rental_fee_cents=CASE isbn
                    WHEN '9780451524935' THEN 1500
                    WHEN '9780747532699' THEN 2500
                    WHEN '9780141439518' THEN 1500
                    WHEN '9780553803716' THEN 2000
                    WHEN '9780553380163' THEN 2000
                    ELSE rental_fee_cents
                END
                WHERE isbn IN ('9780451524935','9780747532699','9780141439518',
                               '9780553803716','9780553380163')
                  AND rental_fee_cents=0;
                """);
            Execute(connection, transaction,
                "INSERT INTO app_settings(setting_key,setting_value) VALUES(@key,@value);",
                ("@key", "seeded-rental-fees-v1"), ("@value", DateTime.UtcNow.ToString("O")));
        }

        transaction.Commit();
    }

    public object GetDashboard(bool systemAdmin) => new
    {
        totalBooks = Scalar("SELECT COALESCE(SUM(total_copies),0) FROM books;"),
        totalMembers = Scalar("SELECT COUNT(*) FROM members WHERE archived_utc IS NULL;"),
        issuedBooks = Scalar("SELECT COUNT(*) FROM loans WHERE return_date IS NULL;"),
        books = GetBooks("").Reverse().Take(2),
        loans = GetLoans().Take(6)
    };

    public object GetMemberDashboard(long memberId)
    {
        return new
        {
            totalBooks = Scalar("SELECT COALESCE(SUM(total_copies),0) FROM books;"),
            availableBooks = Scalar("""
                SELECT COALESCE(SUM(b.total_copies - (
                    SELECT COUNT(*) FROM loans l WHERE l.book_id=b.book_id AND l.return_date IS NULL
                ) - (
                    SELECT COUNT(*) FROM loan_requests r WHERE r.book_id=b.book_id AND r.status='Pending'
                ) - b.lost_copies - b.damaged_copies),0) FROM books b;
                """),
            borrowedBooks = Scalar("SELECT COUNT(*) FROM loans WHERE member_id=@id;", ("@id", memberId)),
            readBooks = Scalar("SELECT COUNT(*) FROM loans WHERE member_id=@id AND return_date IS NOT NULL;", ("@id", memberId)),
            books = GetBooks("").Reverse().Take(2),
            loans = GetLoans(activeOnly: true, memberId: memberId)
        };
    }

    public IReadOnlyList<object> GetBooks(
        string search, long? userId = null, bool pinnedOnly = false, long? categoryId = null, long? subcategoryId = null)
    {
        var books = new List<object>();
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT b.book_id,b.title,b.isbn,a.name,c.category_name,
                   COALESCE(s.subcategory_name,''),b.publication_year,b.total_copies,
                   MAX(0,b.total_copies - (SELECT COUNT(*) FROM loans l
                       WHERE l.book_id=b.book_id AND l.return_date IS NULL) - (
                       SELECT COUNT(*) FROM loan_requests r
                       WHERE r.book_id=b.book_id AND r.status='Pending') - b.lost_copies - b.damaged_copies),
                   CASE WHEN @userId IS NULL THEN 0 ELSE EXISTS(
                       SELECT 1 FROM pinned_books p WHERE p.user_id=@userId AND p.book_id=b.book_id) END,
                   CASE WHEN @userId IS NULL THEN 0 ELSE EXISTS(
                       SELECT 1 FROM loan_requests r JOIN app_users u ON u.member_id=r.member_id
                       WHERE u.user_id=@userId AND r.book_id=b.book_id AND r.status='Pending') END,
                   CASE WHEN @userId IS NULL THEN 0 ELSE EXISTS(
                       SELECT 1 FROM loans l JOIN app_users u ON u.member_id=l.member_id
                       WHERE u.user_id=@userId AND l.book_id=b.book_id AND l.return_date IS NULL) END,
                   b.lost_copies,b.damaged_copies,b.rental_fee_cents,b.cover_image IS NOT NULL
            FROM books b
            JOIN authors a ON a.author_id=b.author_id
            JOIN categories c ON c.category_id=b.category_id
            LEFT JOIN subcategories s ON s.subcategory_id=b.subcategory_id
            WHERE (CAST(b.book_id AS TEXT) LIKE @search
               OR b.title LIKE @search COLLATE NOCASE
               OR b.isbn LIKE @search
               OR a.name LIKE @search COLLATE NOCASE
               OR c.category_name LIKE @search COLLATE NOCASE
               OR COALESCE(s.subcategory_name,'') LIKE @search COLLATE NOCASE)
            AND (@pinnedOnly=0 OR EXISTS(
                SELECT 1 FROM pinned_books p WHERE p.user_id=@userId AND p.book_id=b.book_id))
            AND (@categoryId IS NULL OR b.category_id=@categoryId)
            AND (@subcategoryId IS NULL OR b.subcategory_id=@subcategoryId)
            ORDER BY b.book_id;
            """;
        command.Parameters.AddWithValue("@search", $"%{search.Trim()}%");
        command.Parameters.AddWithValue("@userId", userId ?? (object)DBNull.Value);
        command.Parameters.AddWithValue("@pinnedOnly", pinnedOnly ? 1 : 0);
        command.Parameters.AddWithValue("@categoryId", categoryId ?? (object)DBNull.Value);
        command.Parameters.AddWithValue("@subcategoryId", subcategoryId ?? (object)DBNull.Value);
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            books.Add(new
            {
                id = reader.GetInt64(0),
                title = reader.GetString(1),
                isbn = reader.GetString(2),
                author = reader.GetString(3),
                category = reader.GetString(4),
                subcategory = reader.GetString(5),
                year = reader.IsDBNull(6) ? (int?)null : reader.GetInt32(6),
                totalCopies = reader.GetInt32(7),
                availableCopies = reader.GetInt32(8),
                available = reader.GetInt32(8) > 0,
                stockStatus = reader.GetInt32(8) == 0 ? "Out of Stock" : reader.GetInt32(8) <= 2 ? "Low Stock" : "Stock",
                isPinned = reader.GetInt64(9) != 0,
                hasPendingRequest = reader.GetInt64(10) != 0,
                hasActiveLoan = reader.GetInt64(11) != 0,
                lostCopies = reader.GetInt32(12),
                damagedCopies = reader.GetInt32(13),
                rentalFee = reader.GetInt32(14) / 100m,
                coverUrl = reader.GetBoolean(15) ? $"/api/books/{reader.GetInt64(0)}/cover" : null
            });
        }
        return books;
    }

    public IReadOnlyList<object> GetBookCopies(long bookId)
    {
        var copies = new List<object>();
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            WITH RECURSIVE copy_numbers(number) AS (
                SELECT 1 WHERE EXISTS (SELECT 1 FROM books WHERE book_id=@book)
                UNION ALL
                SELECT number+1 FROM copy_numbers
                WHERE number < (SELECT total_copies FROM books WHERE book_id=@book)
            )
            SELECT copy_numbers.number,
                CASE
                    WHEN conditions.condition IS NOT NULL THEN conditions.condition
                    WHEN loans.loan_id IS NOT NULL THEN 'Borrowed'
                    WHEN requests.request_id IS NOT NULL THEN 'Reserved'
                    ELSE 'Available'
                END,
                CASE
                    WHEN conditions.condition IS NOT NULL THEN 'Not available for checkout'
                    WHEN loans.loan_id IS NOT NULL THEN members.name || ' · due ' || loans.due_date
                    WHEN requests.request_id IS NOT NULL THEN 'Pending request · ' || request_members.name
                    ELSE 'Ready to borrow'
                END
            FROM copy_numbers
            LEFT JOIN book_copy_conditions conditions
                ON conditions.book_id=@book AND conditions.copy_number=copy_numbers.number
            LEFT JOIN loans
                ON loans.book_id=@book AND loans.copy_number=copy_numbers.number AND loans.return_date IS NULL
            LEFT JOIN members ON members.member_id=loans.member_id
            LEFT JOIN loan_requests requests
                ON requests.book_id=@book AND requests.copy_number=copy_numbers.number AND requests.status='Pending'
            LEFT JOIN members request_members ON request_members.member_id=requests.member_id
            ORDER BY copy_numbers.number;
            """;
        command.Parameters.AddWithValue("@book", bookId);
        using var reader = command.ExecuteReader();
        while (reader.Read())
            copies.Add(new { copyNumber = reader.GetInt32(0), status = reader.GetString(1), detail = reader.GetString(2) });
        return copies;
    }

    public IReadOnlyList<object> GetPinnedBooks(long userId) => GetBooks("", userId, pinnedOnly: true);

    public void TogglePinnedBook(long userId, long bookId)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        if (Scalar(connection, transaction, "SELECT COUNT(*) FROM books WHERE book_id=@id;", ("@id", bookId)) == 0)
            throw new InvalidOperationException("Book not found.");

        var isPinned = Scalar(connection, transaction,
            "SELECT COUNT(*) FROM pinned_books WHERE user_id=@user AND book_id=@book;",
            ("@user", userId), ("@book", bookId)) != 0;
        if (isPinned)
            Execute(connection, transaction, "DELETE FROM pinned_books WHERE user_id=@user AND book_id=@book;",
                ("@user", userId), ("@book", bookId));
        else
            Execute(connection, transaction, "INSERT INTO pinned_books(user_id,book_id) VALUES(@user,@book);",
                ("@user", userId), ("@book", bookId));
        transaction.Commit();
    }

    public IReadOnlyList<object> GetMembers()
    {
        var members = new List<object>();
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT m.member_id,m.name,m.email,COALESCE(m.phone,''),COUNT(l.loan_id),
                   u.user_id,u.last_seen_utc,u.created_utc,m.join_date
            FROM members m
            LEFT JOIN loans l ON l.member_id=m.member_id AND l.return_date IS NULL
            LEFT JOIN app_users u ON u.member_id=m.member_id AND u.archived_utc IS NULL
            WHERE m.archived_utc IS NULL
            GROUP BY m.member_id,m.name,m.email,m.phone
            ORDER BY m.member_id;
            """;
        using var reader = command.ExecuteReader();
        while (reader.Read())
            members.Add(new
            {
                id = reader.GetInt64(0),
                name = reader.GetString(1),
                email = reader.GetString(2),
                phone = reader.GetString(3),
                issuedBooks = reader.GetInt32(4),
                hasAccount = !reader.IsDBNull(5),
                status = GetPresenceStatus(
                    reader.IsDBNull(6) ? null : reader.GetString(6),
                    reader.IsDBNull(7) ? reader.GetString(8) : reader.GetString(7)),
                lastSeen = reader.IsDBNull(6) ? null : reader.GetString(6)
            });
        return members;
    }

    public IReadOnlyList<object> GetLoans(bool activeOnly = false, long? memberId = null, string? search = null, string? loanDate = null)
    {
        var loans = new List<object>();
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT l.loan_id,m.name,b.title,l.loan_date,l.due_date,l.return_date,
                   l.renewal_count,
                   EXISTS(SELECT 1 FROM loan_renewal_requests rr
                       WHERE rr.loan_id=l.loan_id AND rr.status='Pending'),
                   l.fine_amount_cents,
                   CASE WHEN l.return_date IS NULL THEN 'Issued' ELSE 'Returned' END,
                   EXISTS(SELECT 1 FROM loan_requests r
                       WHERE r.book_id=l.book_id AND r.member_id<>l.member_id AND r.status='Pending'),
                   l.return_requested_utc,l.rental_fee_cents
            FROM loans l JOIN members m ON m.member_id=l.member_id
            JOIN books b ON b.book_id=l.book_id
            WHERE (@activeOnly=0 OR l.return_date IS NULL)
              AND (@memberId IS NULL OR l.member_id=@memberId)
              AND (@loanDate='' OR date(l.loan_date)=date(@loanDate))
              AND (@search='' OR m.name LIKE @search COLLATE NOCASE
                   OR b.title LIKE @search COLLATE NOCASE
                   OR CAST(l.loan_id AS TEXT) LIKE @search
                   OR l.loan_date LIKE @search
                   OR l.due_date LIKE @search
                   OR COALESCE(l.return_date,'') LIKE @search
                   OR CASE WHEN l.return_date IS NULL THEN 'Issued' ELSE 'Returned' END LIKE @search COLLATE NOCASE)
            ORDER BY l.loan_id DESC;
            """;
        command.Parameters.AddWithValue("@activeOnly", activeOnly ? 1 : 0);
        command.Parameters.AddWithValue("@memberId", memberId ?? (object)DBNull.Value);
        command.Parameters.AddWithValue("@loanDate", loanDate ?? "");
        command.Parameters.AddWithValue("@search", string.IsNullOrWhiteSpace(search) ? "" : $"%{search.Trim()}%");
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            var dueDate = DateTime.Parse(reader.GetString(4)).Date;
            var returnDate = reader.IsDBNull(5) ? (DateTime?)null : DateTime.Parse(reader.GetString(5)).Date;
            var effectiveDate = returnDate ?? DateTime.Today;
            var overdueDays = Math.Max(0, (effectiveDate - dueDate).Days);
            var renewalPending = reader.GetInt32(7) != 0;
            var active = !returnDate.HasValue;
            var returnPending = active && !reader.IsDBNull(11);
            loans.Add(new
            {
                id = reader.GetInt64(0),
                member = reader.GetString(1),
                book = reader.GetString(2),
                loanDate = reader.GetString(3),
                dueDate = reader.GetString(4),
                returnDate = reader.IsDBNull(5) ? null : reader.GetString(5),
                renewalCount = reader.GetInt32(6),
                renewalPending,
                returnPending,
                returnRequestedAt = reader.IsDBNull(11) ? null : reader.GetString(11),
                status = reader.GetString(9),
                overdueDays,
                fineAmount = (active ? overdueDays * FinePerDayCents : reader.GetInt32(8)) / 100m,
                rentalFee = reader.GetInt32(12) / 100m,
                dueStatus = active ? GetDueStatus(dueDate) : "Returned",
                canRenew = active && !returnPending && reader.GetInt32(6) == 0 && !renewalPending
                    && dueDate >= DateTime.Today && reader.GetInt32(10) == 0
            });
        }
        return loans;
    }

    private static string GetDueStatus(DateTime dueDate)
    {
        var daysUntilDue = (dueDate - DateTime.Today).Days;
        return daysUntilDue < 0 ? "Overdue" : daysUntilDue <= 3 ? "Due soon" : "On time";
    }

    public IReadOnlyList<object> GetPendingLoanRequests()
    {
        var requests = new List<object>();
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT r.request_id,m.name,b.title,r.requested_utc,b.rental_fee_cents
            FROM loan_requests r
            JOIN members m ON m.member_id=r.member_id
            JOIN books b ON b.book_id=r.book_id
            WHERE r.status='Pending'
            ORDER BY r.request_id;
            """;
        using var reader = command.ExecuteReader();
        while (reader.Read())
            requests.Add(new
            {
                id = reader.GetInt64(0),
                member = reader.GetString(1),
                book = reader.GetString(2),
                requestedAt = reader.GetString(3),
                rentalFee = reader.GetInt32(4) / 100m
            });
        return requests;
    }

    public IReadOnlyList<object> GetPendingRenewalRequests()
    {
        var requests = new List<object>();
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT rr.renewal_request_id,m.name,b.title,l.due_date,rr.requested_utc
            FROM loan_renewal_requests rr
            JOIN loans l ON l.loan_id=rr.loan_id
            JOIN members m ON m.member_id=l.member_id
            JOIN books b ON b.book_id=l.book_id
            WHERE rr.status='Pending'
            ORDER BY rr.renewal_request_id;
            """;
        using var reader = command.ExecuteReader();
        while (reader.Read())
            requests.Add(new
            {
                id = reader.GetInt64(0),
                member = reader.GetString(1),
                book = reader.GetString(2),
                dueDate = reader.GetString(3),
                requestedAt = reader.GetString(4)
            });
        return requests;
    }

    public object GetCategories()
    {
        var categories = new List<object>();
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT category_id,category_name FROM categories ORDER BY category_name;";
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            var id = reader.GetInt64(0);
            categories.Add(new
            {
                id,
                name = reader.GetString(1),
                subcategories = GetSubcategories(connection, id)
            });
        }
        return categories;
    }

    public long AddBook(BookInput input, byte[]? coverImage = null, string? coverContentType = null)
    {
        var title = Required(input.Title, "Enter the book title.", 200);
        var isbn = Required(input.Isbn, "Enter the ISBN.", 32);
        var author = Required(input.Author, "Enter the author's name.", 160);
        if (input.PublicationYear < 1000 || input.PublicationYear > DateTime.Today.Year)
            throw new InvalidOperationException("Enter a valid publication year.");
        if (input.TotalCopies < 1 || input.TotalCopies > 10000)
            throw new InvalidOperationException("The number of copies must be between 1 and 10,000.");
        var rentalFeeCents = ToRentalFeeCents(input.RentalFee);

        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        if (Scalar(connection, transaction, "SELECT COUNT(*) FROM books WHERE isbn=@isbn;", ("@isbn", isbn)) > 0)
            throw new InvalidOperationException("A book with that ISBN already exists.");
        if (Scalar(connection, transaction,
            "SELECT COUNT(*) FROM subcategories WHERE subcategory_id=@sub AND category_id=@cat;",
            ("@sub", input.SubcategoryId), ("@cat", input.CategoryId)) == 0)
            throw new InvalidOperationException("Select a valid category and subcategory.");

        var authorId = Scalar(connection, transaction,
            "SELECT COALESCE((SELECT author_id FROM authors WHERE name=@name),0);", ("@name", author));
        if (authorId == 0)
        {
            Execute(connection, transaction, "INSERT INTO authors(name) VALUES(@name);", ("@name", author));
            authorId = Scalar(connection, transaction, "SELECT last_insert_rowid();");
        }

        Execute(connection, transaction, """
            INSERT INTO books(title,isbn,publication_year,total_copies,rental_fee_cents,author_id,category_id,subcategory_id,cover_image,cover_image_content_type)
            VALUES(@title,@isbn,@year,@copies,@rentalFee,@author,@category,@subcategory,@cover,@coverContentType);
            """, ("@title", title), ("@isbn", isbn), ("@year", input.PublicationYear),
            ("@copies", input.TotalCopies), ("@rentalFee", rentalFeeCents), ("@author", authorId),
            ("@category", input.CategoryId), ("@subcategory", input.SubcategoryId),
            ("@cover", coverImage), ("@coverContentType", coverContentType));
        var bookId = Scalar(connection, transaction, "SELECT last_insert_rowid();");
        transaction.Commit();
        return bookId;
    }

    public (byte[] Data, string ContentType)? GetBookCover(long bookId)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT cover_image,cover_image_content_type
            FROM books
            WHERE book_id=@id AND cover_image IS NOT NULL;
            """;
        command.Parameters.AddWithValue("@id", bookId);
        using var reader = command.ExecuteReader();
        if (!reader.Read())
            return null;
        return (reader.GetFieldValue<byte[]>(0), reader.GetString(1));
    }

    public void SaveBookCover(long bookId, byte[] data, string contentType)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE books
            SET cover_image=@image,cover_image_content_type=@contentType
            WHERE book_id=@id;
            """;
        command.Parameters.AddWithValue("@image", data);
        command.Parameters.AddWithValue("@contentType", contentType);
        command.Parameters.AddWithValue("@id", bookId);
        if (command.ExecuteNonQuery() == 0)
            throw new InvalidOperationException("Book not found.");
    }

    public void DeleteBookCover(long bookId)
    {
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            UPDATE books
            SET cover_image=NULL,cover_image_content_type=NULL
            WHERE book_id=@id;
            """;
        command.Parameters.AddWithValue("@id", bookId);
        if (command.ExecuteNonQuery() == 0)
            throw new InvalidOperationException("Book not found.");
    }

    public void AddBookStock(long bookId, int quantity)
    {
        if (quantity is < 1 or > 10000)
            throw new InvalidOperationException("Enter a quantity between 1 and 10,000 copies.");

        using var connection = Open();
        if (Execute(connection, null, """
            UPDATE books SET total_copies=total_copies+@quantity
            WHERE book_id=@id AND total_copies<=100000-@quantity;
            """, ("@quantity", quantity), ("@id", bookId)) == 0)
        {
            if (Scalar(connection, null, "SELECT COUNT(*) FROM books WHERE book_id=@id;", ("@id", bookId)) == 0)
                throw new InvalidOperationException("Book not found.");
            throw new InvalidOperationException("A book cannot have more than 100,000 total copies.");
        }
    }

    public void UpdateBookRentalFee(long bookId, decimal rentalFee)
    {
        var rentalFeeCents = ToRentalFeeCents(rentalFee);
        using var connection = Open();
        if (Execute(connection, null, """
            UPDATE books SET rental_fee_cents=@fee WHERE book_id=@id;
            """, ("@fee", rentalFeeCents), ("@id", bookId)) == 0)
            throw new InvalidOperationException("Book not found.");
    }

    public void DeleteBook(long id)
    {
        using var connection = Open();
        if (Scalar(connection, null, "SELECT COUNT(*) FROM books WHERE book_id=@id;", ("@id", id)) == 0)
            throw new InvalidOperationException("Book not found.");
        if (Scalar(connection, null, """
            SELECT (SELECT COUNT(*) FROM loans WHERE book_id=@id)
                 + (SELECT COUNT(*) FROM loan_requests WHERE book_id=@id);
            """, ("@id", id)) > 0)
            throw new InvalidOperationException("This book cannot be deleted because it has loan or borrow request records.");
        Execute(connection, null, "DELETE FROM books WHERE book_id=@id;", ("@id", id));
    }

    public void UpdateBookCondition(long bookId, string? condition, string? action, int copyNumber)
    {
        var column = condition switch
        {
            "Lost" => "lost_copies",
            "Damaged" => "damaged_copies",
            _ => throw new InvalidOperationException("Choose Lost or Damaged as the copy condition.")
        };
        if (copyNumber < 1)
            throw new InvalidOperationException("Choose a valid numbered copy.");

        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        int changed;
        if (action == "mark")
        {
            if (Scalar(connection, transaction, """
                SELECT COUNT(*) FROM books b
                WHERE b.book_id=@id AND @copy<=b.total_copies
                  AND NOT EXISTS (SELECT 1 FROM book_copy_conditions c WHERE c.book_id=b.book_id AND c.copy_number=@copy)
                  AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.book_id=b.book_id AND l.copy_number=@copy AND l.return_date IS NULL)
                  AND NOT EXISTS (SELECT 1 FROM loan_requests r WHERE r.book_id=b.book_id AND r.copy_number=@copy AND r.status='Pending');
                """, ("@id", bookId), ("@copy", copyNumber)) == 0)
                throw new InvalidOperationException($"Copy #{copyNumber} is no longer available to mark. Refresh the copy list and choose an available copy.");
            changed = Execute(connection, transaction, $"""
                INSERT INTO book_copy_conditions(book_id,copy_number,condition)
                VALUES(@id,@copy,@condition);
                UPDATE books SET {column}={column}+1 WHERE book_id=@id;
                """, ("@id", bookId), ("@copy", copyNumber), ("@condition", condition));
        }
        else if (action == "restore")
        {
            if (Scalar(connection, transaction, """
                SELECT COUNT(*) FROM book_copy_conditions
                WHERE book_id=@id AND copy_number=@copy AND condition=@condition;
                """, ("@id", bookId), ("@copy", copyNumber), ("@condition", condition)) == 0)
                throw new InvalidOperationException($"Copy #{copyNumber} is no longer marked as {condition?.ToLowerInvariant()}. Refresh the copy list and choose another copy.");
            changed = Execute(connection, transaction, $"""
                DELETE FROM book_copy_conditions WHERE book_id=@id AND copy_number=@copy AND condition=@condition;
                UPDATE books SET {column}={column}-1 WHERE book_id=@id AND {column}>0;
                """, ("@id", bookId), ("@copy", copyNumber), ("@condition", condition));
        }
        else
        {
            throw new InvalidOperationException("Choose whether to mark or restore a copy.");
        }

        if (changed == 0)
            throw new InvalidOperationException(action == "mark"
                ? $"Copy #{copyNumber} could not be marked."
                : $"Copy #{copyNumber} could not be restored.");
        transaction.Commit();
    }

    private static long ToRentalFeeCents(decimal rentalFee)
    {
        if (rentalFee is < 0 or > 1000000)
            throw new InvalidOperationException("The simulated rental fee must be between PHP 0.00 and PHP 1,000,000.00.");
        if (decimal.Round(rentalFee, 2) != rentalFee)
            throw new InvalidOperationException("The simulated rental fee can have up to two decimal places.");
        return checked((long)(rentalFee * 100m));
    }

    public void AddMember(MemberInput input)
    {
        var name = Required(input.Name, "Enter the member's name.", 120);
        var email = Required(input.Email, "Enter an email address.", 254);
        try
        {
            if (new MailAddress(email).Address != email)
                throw new FormatException();
        }
        catch (FormatException)
        {
            throw new InvalidOperationException("Enter a valid email address.");
        }

        if (input.Phone?.Trim().Length > 40)
            throw new InvalidOperationException("Phone number cannot exceed 40 characters.");
        using var connection = Open();
        if (Scalar(connection, null, "SELECT COUNT(*) FROM members WHERE email=@email COLLATE NOCASE;",
                ("@email", email)) > 0)
            throw new InvalidOperationException("Another member is already using that email address.");
        Execute(connection, null, """
            INSERT INTO members(name,email,phone,join_date) VALUES(@name,@email,@phone,@date);
            """, ("@name", name), ("@email", email),
            ("@phone", string.IsNullOrWhiteSpace(input.Phone) ? null : input.Phone.Trim()),
            ("@date", DateTime.Today.ToString("yyyy-MM-dd")));
    }

    public void RequestBook(long memberId, long bookId)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        if (Scalar(connection, transaction, "SELECT COUNT(*) FROM members WHERE member_id=@id;", ("@id", memberId)) == 0)
            throw new InvalidOperationException("Member account not found.");
        if (Scalar(connection, transaction, """
            SELECT COUNT(*) FROM loan_requests
            WHERE member_id=@member AND book_id=@book AND status='Pending';
            """, ("@member", memberId), ("@book", bookId)) > 0)
            throw new InvalidOperationException("You already have a pending request for this book.");
        if (Scalar(connection, transaction, """
            SELECT COUNT(*) FROM books b WHERE b.book_id=@book AND b.total_copies-b.lost_copies-b.damaged_copies > (
                SELECT COUNT(*) FROM loans l WHERE l.book_id=b.book_id AND l.return_date IS NULL
            ) + (
                SELECT COUNT(*) FROM loan_requests r WHERE r.book_id=b.book_id AND r.status='Pending'
            );
            """, ("@book", bookId)) == 0)
            throw new InvalidOperationException("This book is not available to request.");

        var totalCopies = Scalar(connection, transaction, "SELECT total_copies FROM books WHERE book_id=@book;",
            ("@book", bookId));
        var copyNumber = FindAvailableCopyNumber(connection, transaction, bookId, checked((int)totalCopies));
        if (copyNumber is null)
            throw new InvalidOperationException("This book is not available to request.");
        Execute(connection, transaction, """
            INSERT INTO loan_requests(member_id,book_id,copy_number) VALUES(@member,@book,@copy);
            """, ("@member", memberId), ("@book", bookId), ("@copy", copyNumber.Value));
        transaction.Commit();
    }

    public BorrowReceipt ApproveLoanRequest(long requestId)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using var request = connection.CreateCommand();
        request.Transaction = transaction;
        request.CommandText = """
            SELECT member_id,book_id,copy_number FROM loan_requests
            WHERE request_id=@id AND status='Pending';
            """;
        request.Parameters.AddWithValue("@id", requestId);
        using var reader = request.ExecuteReader();
        if (!reader.Read())
            throw new InvalidOperationException("Pending borrow request not found.");
        var memberId = reader.GetInt64(0);
        var bookId = reader.GetInt64(1);
        var copyNumber = reader.IsDBNull(2) ? (int?)null : reader.GetInt32(2);
        reader.Close();

        if (copyNumber is null || Scalar(connection, transaction, """
            SELECT COUNT(*) FROM books b
            WHERE b.book_id=@book AND @copy<=b.total_copies
              AND NOT EXISTS (SELECT 1 FROM book_copy_conditions c WHERE c.book_id=b.book_id AND c.copy_number=@copy)
              AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.book_id=b.book_id AND l.copy_number=@copy AND l.return_date IS NULL);
            """, ("@book", bookId), ("@copy", copyNumber)) == 0)
            throw new InvalidOperationException("No copy is currently available to approve this request.");

        var today = DateTime.Today;
        Execute(connection, transaction, """
            INSERT INTO loans(member_id,book_id,loan_date,due_date,return_date,rental_fee_cents,copy_number)
            SELECT @member,@book,@loan,@due,NULL,rental_fee_cents,@copy
            FROM books WHERE book_id=@book;
            """, ("@member", memberId), ("@book", bookId),
            ("@copy", copyNumber.Value),
            ("@loan", today.ToString("yyyy-MM-dd")), ("@due", today.AddDays(LoanPeriodDays).ToString("yyyy-MM-dd")));
        var loanId = Scalar(connection, transaction, "SELECT last_insert_rowid();");
        if (Execute(connection, transaction, """
            UPDATE loan_requests
            SET status='Approved',processed_utc=strftime('%Y-%m-%dT%H:%M:%fZ','now'),loan_id=@loan
            WHERE request_id=@id AND status='Pending';
            """, ("@loan", loanId), ("@id", requestId)) == 0)
            throw new InvalidOperationException("Pending borrow request not found.");
        using var receiptCommand = connection.CreateCommand();
        receiptCommand.Transaction = transaction;
        receiptCommand.CommandText = """
            SELECT m.name,m.email,b.title,l.loan_date,l.due_date,l.rental_fee_cents
            FROM loans l JOIN members m ON m.member_id=l.member_id
            JOIN books b ON b.book_id=l.book_id
            WHERE l.loan_id=@id;
            """;
        receiptCommand.Parameters.AddWithValue("@id", loanId);
        using var receiptReader = receiptCommand.ExecuteReader();
        if (!receiptReader.Read())
            throw new InvalidOperationException("The approved loan could not be loaded for its receipt.");
        var receipt = new BorrowReceipt(
            receiptReader.GetString(0), receiptReader.GetString(1), receiptReader.GetString(2),
            receiptReader.GetString(3), receiptReader.GetString(4), receiptReader.GetInt32(5) / 100m);
        receiptReader.Close();
        transaction.Commit();
        return receipt;
    }

    public void RequestLoanRenewal(long loanId, long memberId)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using var loanCommand = connection.CreateCommand();
        loanCommand.Transaction = transaction;
        loanCommand.CommandText = """
            SELECT book_id,due_date,renewal_count,return_requested_utc
            FROM loans WHERE loan_id=@loan AND member_id=@member AND return_date IS NULL;
            """;
        loanCommand.Parameters.AddWithValue("@loan", loanId);
        loanCommand.Parameters.AddWithValue("@member", memberId);
        using var reader = loanCommand.ExecuteReader();
        if (!reader.Read())
            throw new InvalidOperationException("Active loan not found, or you are not authorized to renew it.");
        var bookId = reader.GetInt64(0);
        var dueDate = DateTime.Parse(reader.GetString(1)).Date;
        var renewalCount = reader.GetInt32(2);
        var returnPending = !reader.IsDBNull(3);
        reader.Close();
        if (returnPending)
            throw new InvalidOperationException("A return request is already pending for this loan.");
        if (dueDate < DateTime.Today)
            throw new InvalidOperationException("Overdue loans cannot be renewed.");
        if (renewalCount >= 1)
            throw new InvalidOperationException("This loan has already been renewed once.");
        if (Scalar(connection, transaction, """
            SELECT COUNT(*) FROM loan_renewal_requests
            WHERE loan_id=@loan AND status='Pending';
            """, ("@loan", loanId)) > 0)
            throw new InvalidOperationException("A renewal request is already pending for this loan.");
        if (HasOtherMemberPendingRequest(connection, transaction, bookId, memberId))
            throw new InvalidOperationException("This book has been requested by another member and cannot be renewed.");
        Execute(connection, transaction, """
            INSERT INTO loan_renewal_requests(loan_id) VALUES(@loan);
            """, ("@loan", loanId));
        transaction.Commit();
    }

    public void ApproveLoanRenewal(long renewalRequestId)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using var request = connection.CreateCommand();
        request.Transaction = transaction;
        request.CommandText = """
            SELECT rr.loan_id,l.book_id,l.member_id,l.due_date,l.renewal_count
            FROM loan_renewal_requests rr JOIN loans l ON l.loan_id=rr.loan_id
            WHERE rr.renewal_request_id=@id AND rr.status='Pending'
              AND l.return_date IS NULL AND l.return_requested_utc IS NULL;
            """;
        request.Parameters.AddWithValue("@id", renewalRequestId);
        using var reader = request.ExecuteReader();
        if (!reader.Read())
            throw new InvalidOperationException("Pending renewal request not found.");
        var loanId = reader.GetInt64(0);
        var bookId = reader.GetInt64(1);
        var memberId = reader.GetInt64(2);
        var dueDate = DateTime.Parse(reader.GetString(3)).Date;
        var renewalCount = reader.GetInt32(4);
        reader.Close();
        if (dueDate < DateTime.Today)
            throw new InvalidOperationException("Overdue loans cannot be renewed.");
        if (renewalCount >= 1)
            throw new InvalidOperationException("This loan has already been renewed once.");
        if (HasOtherMemberPendingRequest(connection, transaction, bookId, memberId))
            throw new InvalidOperationException("This book has been requested by another member and cannot be renewed.");
        if (Execute(connection, transaction, """
            UPDATE loans SET due_date=@due,renewal_count=renewal_count+1
            WHERE loan_id=@loan AND return_date IS NULL AND renewal_count=0;
            """, ("@due", dueDate.AddDays(LoanPeriodDays).ToString("yyyy-MM-dd")),
            ("@loan", loanId)) == 0)
            throw new InvalidOperationException("The loan can no longer be renewed.");
        if (Execute(connection, transaction, """
            UPDATE loan_renewal_requests
            SET status='Approved',processed_utc=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE renewal_request_id=@id AND status='Pending';
            """, ("@id", renewalRequestId)) == 0)
            throw new InvalidOperationException("Pending renewal request not found.");
        transaction.Commit();
    }

    public void RejectLoanRenewal(long renewalRequestId)
    {
        using var connection = Open();
        if (Execute(connection, null, """
            UPDATE loan_renewal_requests
            SET status='Rejected',processed_utc=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE renewal_request_id=@id AND status='Pending';
            """, ("@id", renewalRequestId)) == 0)
            throw new InvalidOperationException("Pending renewal request not found.");
    }

    private static bool HasOtherMemberPendingRequest(
        SqliteConnection connection, SqliteTransaction transaction, long bookId, long memberId) =>
        Scalar(connection, transaction, """
            SELECT COUNT(*) FROM loan_requests
            WHERE book_id=@book AND member_id<>@member AND status='Pending';
            """, ("@book", bookId), ("@member", memberId)) > 0;

    public void RejectLoanRequest(long requestId)
    {
        using var connection = Open();
        if (Execute(connection, null, """
            UPDATE loan_requests
            SET status='Rejected',processed_utc=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE request_id=@id AND status='Pending';
            """, ("@id", requestId)) == 0)
            throw new InvalidOperationException("Pending borrow request not found.");
    }

    public void RequestLoanReturn(long loanId, long memberId)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        if (Scalar(connection, transaction, """
            SELECT COUNT(*) FROM loan_renewal_requests
            WHERE loan_id=@loan AND status='Pending';
            """, ("@loan", loanId)) > 0)
            throw new InvalidOperationException("A renewal request is pending for this loan. Wait for the librarian's decision before requesting a return.");

        if (Execute(connection, transaction, """
            UPDATE loans
            SET return_requested_utc=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE loan_id=@loan AND member_id=@member
              AND return_date IS NULL AND return_requested_utc IS NULL;
            """, ("@loan", loanId), ("@member", memberId)) == 0)
            throw new InvalidOperationException("Active loan not found, or a return request is already pending for this loan.");
        transaction.Commit();
    }

    public IReadOnlyList<object> GetPendingReturnRequests()
    {
        var requests = new List<object>();
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT l.loan_id,m.name,b.title,l.due_date,l.return_requested_utc,l.rental_fee_cents,l.copy_number
            FROM loans l
            JOIN members m ON m.member_id=l.member_id
            JOIN books b ON b.book_id=l.book_id
            WHERE l.return_date IS NULL AND l.return_requested_utc IS NOT NULL
            ORDER BY l.return_requested_utc,l.loan_id;
            """;
        using var reader = command.ExecuteReader();
        while (reader.Read())
            requests.Add(new
            {
                id = reader.GetInt64(0),
                member = reader.GetString(1),
                book = reader.GetString(2),
                dueDate = reader.GetString(3),
                requestedAt = reader.GetString(4),
                rentalFee = reader.GetInt32(5) / 100m,
                copyNumber = reader.GetInt32(6)
            });
        return requests;
    }

    public ReturnedLoan ConfirmBookReturn(long loanId, bool markDamaged = false)
    {
        using var connection = Open();
        using var transaction = connection.BeginTransaction();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT l.due_date,b.title,m.name,l.copy_number,l.book_id FROM loans l
            JOIN books b ON b.book_id=l.book_id JOIN members m ON m.member_id=l.member_id
            WHERE l.loan_id=@id AND l.return_date IS NULL AND l.return_requested_utc IS NOT NULL;
            """;
        command.Transaction = transaction;
        command.Parameters.AddWithValue("@id", loanId);
        using var reader = command.ExecuteReader();
        if (!reader.Read())
            throw new InvalidOperationException("Pending return request not found.");
        var dueDate = DateTime.Parse(reader.GetString(0)).Date;
        var bookTitle = reader.GetString(1);
        var memberName = reader.GetString(2);
        var copyNumber = reader.IsDBNull(3) ? 0 : reader.GetInt32(3);
        var bookId = reader.GetInt64(4);
        reader.Close();
        if (markDamaged && copyNumber < 1)
            throw new InvalidOperationException("This loan has no assigned copy number. Refresh the return request before processing it.");
        var returnDate = DateTime.Today;
        var overdueDays = Math.Max(0, (returnDate - dueDate).Days);
        var fineCents = overdueDays * FinePerDayCents;
        if (Execute(connection, transaction, """
            UPDATE loans SET return_date=@date,fine_amount_cents=@fine
            WHERE loan_id=@id AND return_date IS NULL AND return_requested_utc IS NOT NULL;
            """, ("@date", returnDate.ToString("yyyy-MM-dd")), ("@fine", fineCents), ("@id", loanId)) == 0)
            throw new InvalidOperationException("This return request has already been processed.");
        if (markDamaged)
        {
            if (Scalar(connection, transaction, """
                SELECT COUNT(*) FROM book_copy_conditions
                WHERE book_id=@book AND copy_number=@copy;
                """, ("@book", bookId), ("@copy", copyNumber)) != 0)
                throw new InvalidOperationException($"Copy #{copyNumber} already has a recorded condition. Review its inventory record before confirming this damaged return.");
            Execute(connection, transaction, """
                INSERT INTO book_copy_conditions(book_id,copy_number,condition)
                VALUES(@book,@copy,'Damaged');
                UPDATE books SET damaged_copies=damaged_copies+1 WHERE book_id=@book;
                """, ("@book", bookId), ("@copy", copyNumber));
        }
        transaction.Commit();
        return new ReturnedLoan(bookTitle, memberName, returnDate.ToString("yyyy-MM-dd"), fineCents / 100m, overdueDays, copyNumber);
    }

    public void MarkReturnNotReceived(long loanId)
    {
        using var connection = Open();
        if (Execute(connection, null, """
            UPDATE loans SET return_requested_utc=NULL
            WHERE loan_id=@id AND return_date IS NULL AND return_requested_utc IS NOT NULL;
            """, ("@id", loanId)) == 0)
            throw new InvalidOperationException("Pending return request not found.");
    }

    private static void EnsureColumn(SqliteConnection connection, string table, string column, string definition)
    {
        using var check = connection.CreateCommand();
        check.CommandText = $"PRAGMA table_info({table});";
        using var reader = check.ExecuteReader();
        while (reader.Read())
        {
            if (reader.GetString(1) == column)
                return;
        }
        reader.Close();
        using var alter = connection.CreateCommand();
        alter.CommandText = $"ALTER TABLE {table} ADD COLUMN {column} {definition};";
        alter.ExecuteNonQuery();
    }

    private static void MigrateBookCopyNumbers(SqliteConnection connection)
    {
        var books = new List<(long Id, int Total, int Damaged, int Lost)>();
        using (var command = connection.CreateCommand())
        {
            command.CommandText = "SELECT book_id,total_copies,damaged_copies,lost_copies FROM books;";
            using var reader = command.ExecuteReader();
            while (reader.Read())
                books.Add((reader.GetInt64(0), reader.GetInt32(1), reader.GetInt32(2), reader.GetInt32(3)));
        }

        foreach (var book in books)
        {
            for (var number = 1; number <= book.Damaged + book.Lost; number++)
            {
                var condition = number <= book.Damaged ? "Damaged" : "Lost";
                Execute(connection, null, """
                    INSERT OR IGNORE INTO book_copy_conditions(book_id,copy_number,condition)
                    VALUES(@book,@number,@condition);
                    """, ("@book", book.Id), ("@number", number), ("@condition", condition));
            }

            var activeLoans = new List<long>();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "SELECT loan_id FROM loans WHERE book_id=@book AND return_date IS NULL AND copy_number IS NULL ORDER BY loan_id;";
                command.Parameters.AddWithValue("@book", book.Id);
                using var reader = command.ExecuteReader();
                while (reader.Read())
                    activeLoans.Add(reader.GetInt64(0));
            }
            foreach (var loanId in activeLoans)
            {
                var number = FindAvailableCopyNumber(connection, null, book.Id, book.Total);
                if (number is null)
                    break;
                Execute(connection, null, "UPDATE loans SET copy_number=@number WHERE loan_id=@loan AND copy_number IS NULL;",
                    ("@number", number.Value), ("@loan", loanId));
            }

            var pendingRequests = new List<long>();
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "SELECT request_id FROM loan_requests WHERE book_id=@book AND status='Pending' AND copy_number IS NULL ORDER BY request_id;";
                command.Parameters.AddWithValue("@book", book.Id);
                using var reader = command.ExecuteReader();
                while (reader.Read())
                    pendingRequests.Add(reader.GetInt64(0));
            }
            foreach (var requestId in pendingRequests)
            {
                var number = FindAvailableCopyNumber(connection, null, book.Id, book.Total);
                if (number is null)
                    break;
                Execute(connection, null, "UPDATE loan_requests SET copy_number=@number WHERE request_id=@request AND copy_number IS NULL;",
                    ("@number", number.Value), ("@request", requestId));
            }
        }
    }

    private static int? FindAvailableCopyNumber(
        SqliteConnection connection, SqliteTransaction? transaction, long bookId, int totalCopies,
        long? excludedRequestId = null)
    {
        var occupied = new HashSet<int>();
        using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = """
                SELECT copy_number FROM book_copy_conditions WHERE book_id=@book
                UNION ALL
                SELECT copy_number FROM loans WHERE book_id=@book AND return_date IS NULL AND copy_number IS NOT NULL
                UNION ALL
                SELECT copy_number FROM loan_requests
                WHERE book_id=@book AND status='Pending' AND copy_number IS NOT NULL
                  AND (@excludedRequest IS NULL OR request_id<>@excludedRequest);
                """;
            command.Parameters.AddWithValue("@book", bookId);
            command.Parameters.AddWithValue("@excludedRequest", (object?)excludedRequestId ?? DBNull.Value);
            using var reader = command.ExecuteReader();
            while (reader.Read())
                occupied.Add(reader.GetInt32(0));
        }

        for (var number = 1; number <= totalCopies; number++)
            if (!occupied.Contains(number))
                return number;
        return null;
    }

    private void AddSampleBook(
        SqliteConnection connection, SqliteTransaction transaction, string title,
        string isbn, int year, int author, string category, string subcategory, int totalCopies,
        decimal rentalFee)
    {
        var categoryId = Scalar(connection, transaction,
            "SELECT category_id FROM categories WHERE category_name=@name;", ("@name", category));
        var subcategoryId = Scalar(connection, transaction,
            "SELECT subcategory_id FROM subcategories WHERE category_id=@category AND subcategory_name=@name;",
            ("@category", categoryId), ("@name", subcategory));
        Execute(connection, transaction, """
            INSERT INTO books(title,isbn,publication_year,total_copies,rental_fee_cents,author_id,category_id,subcategory_id)
            VALUES(@title,@isbn,@year,@copies,@rentalFee,@author,@category,@subcategory);
            """, ("@title", title), ("@isbn", isbn), ("@year", year), ("@author", author),
            ("@copies", totalCopies), ("@rentalFee", ToRentalFeeCents(rentalFee)),
            ("@category", categoryId), ("@subcategory", subcategoryId));
    }

    private static IReadOnlyList<object> GetSubcategories(SqliteConnection connection, long categoryId)
    {
        var values = new List<object>();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT subcategory_id,subcategory_name FROM subcategories WHERE category_id=@id ORDER BY subcategory_name;";
        command.Parameters.AddWithValue("@id", categoryId);
        using var reader = command.ExecuteReader();
        while (reader.Read())
            values.Add(new { id = reader.GetInt64(0), name = reader.GetString(1) });
        return values;
    }

    private long Scalar(string sql)
    {
        using var connection = Open();
        return Scalar(connection, null, sql);
    }

    private long Scalar(string sql, params (string Name, object? Value)[] parameters)
    {
        using var connection = Open();
        return Scalar(connection, null, sql, parameters);
    }

    private static long Scalar(
        SqliteConnection connection, SqliteTransaction? transaction, string sql,
        params (string Name, object? Value)[] parameters)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        foreach (var (name, value) in parameters)
            command.Parameters.AddWithValue(name, value ?? DBNull.Value);
        return Convert.ToInt64(command.ExecuteScalar());
    }

    private static int Execute(
        SqliteConnection connection, SqliteTransaction? transaction, string sql,
        params (string Name, object? Value)[] parameters)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        foreach (var (name, value) in parameters)
            command.Parameters.AddWithValue(name, value ?? DBNull.Value);
        return command.ExecuteNonQuery();
    }

    private static string GetPresenceStatus(string? lastSeen, string? fallbackTimestamp)
    {
        var now = DateTimeOffset.UtcNow;
        var lastActivity = DateTimeOffset.TryParse(
            lastSeen ?? fallbackTimestamp,
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.AssumeUniversal,
            out var parsed)
            ? parsed.ToUniversalTime()
            : (DateTimeOffset?)null;
        if (!lastActivity.HasValue || lastActivity.Value < now.AddYears(-1))
            return "Inactive";
        return lastSeen is not null && lastActivity.Value >= now.AddMinutes(-2)
            ? "Online"
            : "Offline";
    }

    private static string Required(string? value, string error, int maxLength)
    {
        var trimmed = value?.Trim() ?? "";
        if (trimmed.Length == 0)
            throw new InvalidOperationException(error);
        if (trimmed.Length > maxLength)
            throw new InvalidOperationException($"This field cannot exceed {maxLength} characters.");
        return trimmed;
    }
}

internal sealed class ReceiptEmailSender(
    IConfiguration configuration,
    ILogger<ReceiptEmailSender> logger,
    IHttpClientFactory httpClientFactory)
{
    public async Task<string?> SendAsync(BorrowReceipt receipt)
    {
        var brevoApiKey = configuration["Email:Brevo:ApiKey"];
        if (!string.IsNullOrWhiteSpace(brevoApiKey))
            return await SendWithBrevoAsync(receipt, brevoApiKey);

        var host = configuration["Email:Smtp:Host"] ?? "smtp.gmail.com";
        var username = configuration["Email:Smtp:Username"];
        var from = configuration["Email:Smtp:From"] ?? username;
        if (string.IsNullOrWhiteSpace(from))
        {
            const string error = "Email sender is not configured; set Email__Smtp__From or Email__Smtp__Username.";
            logger.LogWarning("Borrow receipt for loan due {DueDate} was not emailed because its sender is not configured.", receipt.DueDate);
            return error;
        }

        var portValue = configuration["Email:Smtp:Port"] ?? "587";
        if (!int.TryParse(portValue, out var port) || port is < 1 or > 65535)
        {
            logger.LogWarning("Borrow receipt email was not sent because the SMTP port is invalid.");
            return "SMTP port is invalid; use a port from 1 to 65535.";
        }

        var password = configuration["Email:Smtp:Password"];
        if (string.IsNullOrWhiteSpace(username) != string.IsNullOrWhiteSpace(password))
        {
            logger.LogWarning("Borrow receipt email was not sent because SMTP username and password configuration is incomplete.");
            return "SMTP username and password must either both be configured or both be empty.";
        }
        if (IsAuthenticatedMailHost(host)
            && (string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(password)))
        {
            logger.LogWarning("Borrow receipt email was not sent because credentials for {SmtpHost} are not configured.", host);
            return "This SMTP provider needs Email__Smtp__Username and Email__Smtp__Password set to the sender account and its permitted SMTP credential.";
        }

        var enableSslValue = configuration["Email:Smtp:EnableSsl"];
        if (!string.IsNullOrWhiteSpace(enableSslValue) && !bool.TryParse(enableSslValue, out _))
        {
            logger.LogWarning("Borrow receipt email was not sent because the SMTP TLS setting is invalid.");
            return "Email__Smtp__EnableSsl must be true or false.";
        }

        try
        {
            using var message = new MailMessage(new MailAddress(from), new MailAddress(receipt.MemberEmail))
            {
                Subject = "Your BookNest loan is confirmed",
                Body = CreateReceiptBody(receipt),
                IsBodyHtml = false
            };
            using var client = new SmtpClient(host, port)
            {
                EnableSsl = !bool.TryParse(enableSslValue, out var enableSsl) || enableSsl,
                DeliveryMethod = SmtpDeliveryMethod.Network,
                Timeout = 15000
            };
            if (!string.IsNullOrWhiteSpace(username))
                client.Credentials = new System.Net.NetworkCredential(username, password);
            await client.SendMailAsync(message);
            return null;
        }
        catch (SmtpException exception)
        {
            logger.LogError(exception, "Failed to email a borrowing receipt.");
            return "SMTP delivery failed. Check the server configuration and application log.";
        }
        catch (FormatException exception)
        {
            logger.LogError(exception, "The member email or configured sender email is invalid.");
            return "The member email or configured sender email is invalid.";
        }
        catch (ArgumentException exception)
        {
            logger.LogError(exception, "The SMTP host or sender email configuration is invalid.");
            return "The SMTP host or sender email configuration is invalid.";
        }
        catch (InvalidOperationException exception)
        {
            logger.LogError(exception, "The SMTP client could not send the borrowing receipt.");
            return "The SMTP configuration could not send the receipt. Check the server configuration and application log.";
        }
    }

    private async Task<string?> SendWithBrevoAsync(BorrowReceipt receipt, string apiKey)
    {
        var from = configuration["Email:Brevo:From"];
        if (string.IsNullOrWhiteSpace(from))
        {
            logger.LogWarning("Borrow receipt email was not sent because the Brevo sender address is not configured.");
            return "Set Email__Brevo__From to a verified sender address in the email provider.";
        }

        var senderName = configuration["Email:Brevo:SenderName"] ?? "BookNest Library";
        using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.brevo.com/v3/smtp/email");
        request.Headers.Add("api-key", apiKey);
        request.Content = JsonContent.Create(new
        {
            sender = new { name = senderName, email = from },
            to = new[] { new { email = receipt.MemberEmail, name = receipt.MemberName } },
            subject = "Your BookNest loan is confirmed",
            textContent = CreateReceiptBody(receipt)
        });

        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            using var response = await httpClientFactory.CreateClient().SendAsync(request, timeout.Token);
            if (response.IsSuccessStatusCode)
                return null;

            logger.LogError("Brevo rejected a borrowing receipt with HTTP status {StatusCode}.", (int)response.StatusCode);
            return "The email provider rejected the message. Check that the sender is verified and the API key is valid.";
        }
        catch (HttpRequestException exception)
        {
            logger.LogError(exception, "Failed to send a borrowing receipt through the email provider.");
            return "Could not connect to the email provider. Check the server logs and provider status.";
        }
        catch (OperationCanceledException exception)
        {
            logger.LogError(exception, "Sending a borrowing receipt through the email provider timed out.");
            return "The email provider did not respond in time. Check the server logs and try again.";
        }
    }

    private static string CreateReceiptBody(BorrowReceipt receipt) =>
        $"""
        Good day, {receipt.MemberName},

        Your loan request has been approved, and your book loan is now confirmed.

        Book: {receipt.BookTitle}
        Borrowed: {receipt.LoanDate}
        Due date: {receipt.DueDate}
        Rental fee (14-day loan): PHP {receipt.RentalFee:0.00}

        Please return the book by the due date. Late returns incur a fine of PHP 5.00 per day.

        Thank you,
        BookNest Library
        """;

    private static bool IsAuthenticatedMailHost(string host) =>
        host.Equals("smtp.gmail.com", StringComparison.OrdinalIgnoreCase)
        || host.Equals("smtp.office365.com", StringComparison.OrdinalIgnoreCase)
        || host.Equals("smtp-mail.outlook.com", StringComparison.OrdinalIgnoreCase);
}
