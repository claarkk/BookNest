    const root=document.getElementById("page"), crumb=document.getElementById("crumb"), authRoot=document.getElementById("auth");
    const pageNames={dashboard:"Dashboard",books:"Books",pinned:"Pinned Books",members:"List of Members",librarians:"List of Librarians",applications:"Applications",archive:"Archived accounts",addBook:"Add Book",addMember:"Add Member",issue:"Borrow requests",return:"Return a book",history:"Loan history",staffHistory:"Librarian history",profile:"Profile",accountSettings:"Account Settings",changePassword:"Change password"};
    let currentPage="dashboard", categories=[], currentUser=null, selectedHistoryMember=null, selectedHistoryDate="", selectedHistorySearch="", selectedBookFilter="", selectedStaffHistoryId=null, refreshingNotificationBadges=false, notificationRefreshGeneration=0, reportedReturnApiError=false, knownPendingApplicationIds=null, knownPendingBorrowIds=null, knownPendingReturnIds=null, pendingNotificationDialog=null, avatarRequestGeneration=0, avatarRequestController=null, avatarObjectUrl=null, bookSearchTimer=null, bookRequestGeneration=0, historyRequestGeneration=0;
    const esc=value=>String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
    const bookLogo='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 18.5V7.2c0-.8.6-1.4 1.4-1.4h2.8v14H4.9c-.8 0-1.4-.6-1.4-1.3Zm5.5 0V5.4c0-.8.6-1.4 1.4-1.4h2.8v16h-2.8c-.8 0-1.4-.6-1.4-1.5Zm5.5 0V7.2c0-.8.6-1.4 1.4-1.4h2.8v14h-2.8c-.8 0-1.4-.6-1.4-1.3Z"/><path d="M5.2 9h1.3m4.2-1.8H12m4.2 1.8h1.3"/></svg>';
    const eyeIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
    const eyeOffIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M10.6 5.1A10.7 10.7 0 0 1 12 5c6.4 0 10 7 10 7a15.7 15.7 0 0 1-3.1 3.8M6.2 6.2C3.5 8 2 12 2 12s3.6 7 10 7a10 10 0 0 0 4-.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
    function addPasswordVisibility(container){
      container.querySelectorAll('input[type="password"]').forEach(input=>{
        const wrapper=document.createElement("div");
        wrapper.className="password-input-wrap";
        const toggle=document.createElement("button");
        toggle.className="password-visibility";
        toggle.type="button";
        toggle.setAttribute("aria-label","Show password");
        toggle.setAttribute("aria-pressed","false");
        toggle.innerHTML=eyeIcon;
        input.replaceWith(wrapper);
        wrapper.append(input,toggle);
        toggle.onclick=()=>{
          const visible=input.type==="password";
          input.type=visible?"text":"password";
          toggle.setAttribute("aria-label",visible?"Hide password":"Show password");
          toggle.setAttribute("aria-pressed",String(visible));
          toggle.innerHTML=visible?eyeOffIcon:eyeIcon;
        };
      });
    }
    const dateFormat=new Intl.DateTimeFormat("en-PH",{dateStyle:"medium"});
    const timeFormat=new Intl.DateTimeFormat("en-PH",{timeStyle:"medium"});
    const localDateOffset=offset=>{const date=new Date();date.setDate(date.getDate()+offset);return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`};
    const pendingButtonActions=new WeakMap();
    const presenceStatus=value=>{
      const status=String(value||"Offline").toLowerCase();
      return ["online","offline","inactive"].includes(status)?status:"offline";
    };
    async function api(url,options={}) {
      const bodyIsForm=options.body instanceof FormData;
      const bodyIsBlob=options.body instanceof Blob;
      const contentType=bodyIsBlob&&options.body.type?{"Content-Type":options.body.type}:{};
      const response=await fetch(url,{...options,headers:{...(!bodyIsForm&&!bodyIsBlob?{"Content-Type":"application/json"}:{}),...contentType,...(options.headers||{})}});
      if(response.status!==204&&!response.headers.get("content-type")?.includes("application/json"))
        throw new Error("The server returned a web page instead of API data. Restart BookNest to apply the latest update, then refresh this page.");
      const data=response.status===204?null:await response.json();
      if(response.status===401&&!url.startsWith("/api/auth/"))showLogin();
      if(!response.ok) throw new Error(data?.error||data?.title||"The request could not be completed. Please try again.");
      return data;
    }
    async function cropBookCover(file,title,actionLabel="Use this crop"){
      const dialog=document.createElement("dialog");
      const imageUrl=URL.createObjectURL(file);
      const size={width:360,height:540};
      dialog.className="book-cover-upload-dialog";
      dialog.setAttribute("aria-labelledby","book-cover-upload-title");
      dialog.innerHTML=`<section class="book-cover-upload-card"><header class="confirm-dialog-header"><span class="confirm-dialog-icon book-cover-upload-icon" aria-hidden="true">${bookLogo}</span><div><span class="confirm-dialog-kicker">BOOK COVER</span><h2 id="book-cover-upload-title">Position the cover</h2></div></header><div class="confirm-dialog-content"><p class="book-cover-upload-description"></p><canvas class="book-cover-upload-canvas" width="${size.width}" height="${size.height}" aria-label="Drag the image to position the portrait cover crop"></canvas><div class="book-cover-upload-zoom"><label for="book-cover-zoom">Zoom</label><input id="book-cover-zoom" type="range" min="1" max="3" step="0.01" value="1"></div><div class="book-cover-upload-actions"><button class="button light" type="button" data-cover-cancel>Cancel</button><button class="button primary" type="button" data-cover-save>${esc(actionLabel)}</button></div><p class="book-cover-upload-status" role="status" aria-live="polite"></p></div></section>`;
      dialog.querySelector(".book-cover-upload-description").textContent=`Drag the image inside the portrait frame and adjust the zoom for “${title}”.`;
      const canvas=dialog.querySelector("canvas"),context=canvas.getContext("2d");
      const zoom=dialog.querySelector("#book-cover-zoom");
      const save=dialog.querySelector("[data-cover-save]"),cancel=dialog.querySelector("[data-cover-cancel]");
      const status=dialog.querySelector(".book-cover-upload-status");
      let image=null,scale=1,x=0,y=0,focusX=size.width/2,focusY=size.height/2,pointer=null,finished=false,saving=false,resolveResult;
      const baseScale=()=>Math.max(size.width/image.naturalWidth,size.height/image.naturalHeight);
      const clamp=()=>{
        const width=image.naturalWidth*scale,height=image.naturalHeight*scale;
        x=Math.min(0,Math.max(size.width-width,x));
        y=Math.min(0,Math.max(size.height-height,y));
      };
      const draw=()=>{
        if(!image)return;
        clamp();
        context.clearRect(0,0,size.width,size.height);
        context.drawImage(image,x,y,image.naturalWidth*scale,image.naturalHeight*scale);
      };
      const zoomAtFocus=()=>{
        if(!image)return;
        const imageX=(focusX-x)/scale,imageY=(focusY-y)/scale;
        scale=baseScale()*Number(zoom.value);
        x=focusX-imageX*scale;
        y=focusY-imageY*scale;
        draw();
      };
      const result=new Promise(resolve=>{resolveResult=resolve});
      const finish=value=>{
        if(finished)return;
        finished=true;
        if(dialog.open)dialog.close();
        resolveResult(value);
      };
      dialog.addEventListener("close",()=>{
        URL.revokeObjectURL(imageUrl);
        dialog.remove();
        if(!finished){finished=true;resolveResult(null)}
      },{once:true});
      dialog.addEventListener("cancel",event=>{if(saving)event.preventDefault()});
      dialog.querySelector("[data-cover-cancel]").onclick=()=>finish(null);
      dialog.addEventListener("click",event=>{if(event.target===dialog&&!saving)finish(null)});
      zoom.oninput=zoomAtFocus;
      canvas.onpointerdown=event=>{
        if(!image)return;
        const bounds=canvas.getBoundingClientRect();
        focusX=(event.clientX-bounds.left)*size.width/bounds.width;
        focusY=(event.clientY-bounds.top)*size.height/bounds.height;
        pointer={id:event.pointerId,x:event.clientX,y:event.clientY};
        canvas.setPointerCapture(event.pointerId);
      };
      canvas.onpointermove=event=>{
        if(!pointer||pointer.id!==event.pointerId)return;
        const bounds=canvas.getBoundingClientRect();
        x+=(event.clientX-pointer.x)*size.width/bounds.width;
        y+=(event.clientY-pointer.y)*size.height/bounds.height;
        pointer.x=event.clientX;
        pointer.y=event.clientY;
        focusX=(event.clientX-bounds.left)*size.width/bounds.width;
        focusY=(event.clientY-bounds.top)*size.height/bounds.height;
        clamp();
        context.clearRect(0,0,size.width,size.height);
        context.drawImage(image,x,y,image.naturalWidth*scale,image.naturalHeight*scale);
      };
      canvas.onpointerup=canvas.onpointercancel=()=>{pointer=null};
      save.onclick=async()=>{
        saving=true;save.disabled=true;cancel.disabled=true;status.textContent="Preparing cover…";
        try{
          let blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/jpeg",0.92));
          if(!blob||blob.type!=="image/jpeg")throw new Error("The adjusted cover could not be prepared. Choose another image.");
          for(let quality=0.82;blob.size>2*1024*1024&&quality>=0.5;quality-=0.08)
            blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/jpeg",quality));
          if(blob.size>2*1024*1024)throw new Error("The adjusted cover is too large. Choose another image.");
          finish(blob);
        }catch(error){
          saving=false;save.disabled=false;cancel.disabled=false;
          status.textContent=error.message;showError(error);
        }
      };
      document.body.append(dialog);
      dialog.showModal();
      const imageLoad=new Image();
      imageLoad.onload=()=>{
        image=imageLoad;
        scale=baseScale();
        x=(size.width-image.naturalWidth*scale)/2;
        y=(size.height-image.naturalHeight*scale)/2;
        draw();
        save.focus();
      };
      imageLoad.onerror=()=>{status.textContent="The selected image could not be opened. Choose another cover.";save.disabled=true};
      imageLoad.src=imageUrl;
      return result;
    }
    async function showBookCoverUpload(bookId,title,file,search){
      const cropped=await cropBookCover(file,title,"Save cover");
      if(!cropped)return;
      try{
        await api(`/api/books/${bookId}/cover`,{method:"PUT",body:cropped});
        await books(search);
        notify("Book cover saved.");
      }catch(error){showError(error)}
    }
    function showBookCover(url,title,author){
      const dialog=document.createElement("dialog");
      dialog.className="book-cover-viewer";
      dialog.setAttribute("aria-label",`Book cover for ${title}`);
      dialog.innerHTML=`<section class="book-cover-viewer-card"><header class="book-cover-viewer-header"><span class="book-cover-viewer-icon" aria-hidden="true">${bookLogo}</span><div class="book-cover-viewer-title"><span class="book-cover-viewer-kicker">BOOK COVER</span><strong></strong><span class="book-cover-viewer-author"></span></div><button class="book-cover-viewer-close" type="button" aria-label="Close cover preview"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><div class="book-cover-viewer-content"><div class="book-cover-viewer-image-wrap"><img alt=""></div></div></section>`;
      const image=dialog.querySelector("img");
      image.src=url;
      image.alt=`Cover of ${title}`;
      dialog.querySelector(".book-cover-viewer-title strong").textContent=title;
      dialog.querySelector(".book-cover-viewer-author").textContent=author;
      dialog.querySelector(".book-cover-viewer-close").onclick=()=>dialog.close();
      dialog.addEventListener("click",event=>{if(event.target===dialog)dialog.close()});
      dialog.addEventListener("close",()=>dialog.remove(),{once:true});
      document.body.append(dialog);
      dialog.showModal();
      dialog.querySelector(".book-cover-viewer-close").focus();
    }
    document.addEventListener("click",event=>{
      const coverButton=event.target.closest("[data-view-book-cover]");
      if(coverButton)showBookCover(coverButton.dataset.viewBookCover,coverButton.dataset.bookTitle,coverButton.dataset.bookAuthor);
      if(event.target.closest("dialog"))return;
      document.querySelectorAll(".book-manage-menu[open]").forEach(menu=>{
        if(!menu.contains(event.target))menu.open=false;
      });
    });
    function showAuthCard(title,description,form,submitLabel){
      document.body.classList.remove("application-mode");
      document.body.classList.add("auth-mode");
      authRoot.innerHTML=`<section class="auth-card"><div class="auth-brand"><span class="brand-mark">${bookLogo}</span><span>Book Nest<small>Library Management</small></span></div><h1>${title}</h1><p>${description}</p><div class="auth-error" id="auth-error"></div>${form}<button class="button primary" type="submit" form="auth-form">${submitLabel}</button></section>`;
      const card=authRoot.querySelector(".auth-card");
      addPasswordVisibility(card);
      card.querySelector("#auth-form").onsubmit=async event=>{
        event.preventDefault();
        const button=card.querySelector("button[type=submit]");
        button.disabled=true;
        try{await onSubmit(new FormData(event.currentTarget))}catch(error){const box=card.querySelector("#auth-error");box.textContent=error.message;box.classList.add("visible")}finally{button.disabled=false}
      };
      async function onSubmit(data){
        const values=Object.fromEntries(data);
        if(authRoot.dataset.mode==="setup"){
          if(values.password!==values.confirmPassword)throw new Error("The password and confirmation do not match.");
          await api("/api/auth/setup",{method:"POST",body:JSON.stringify({password:values.password,setupToken:values.setupToken||null})});
        }else{
          await api("/api/auth/login",{method:"POST",body:JSON.stringify(values)});
        }
        await enterApp();
      }
    }
    function playLoginOpeningAnimation(){
      if(window.matchMedia("(prefers-reduced-motion: reduce)").matches)return Promise.resolve();
      const overlay=document.createElement("dialog");
      overlay.className="login-opening-overlay";
      overlay.setAttribute("role","status");
      overlay.setAttribute("aria-live","polite");
      overlay.setAttribute("aria-label","Opening your library");
      overlay.innerHTML=`<div class="login-opening-content"><div class="login-opening-book" aria-hidden="true"><div class="login-book-back"></div><div class="login-book-page login-book-page-left"><span>BOOK NEST</span><i></i><i></i><i></i></div><div class="login-book-page login-book-page-right"><span>YOUR LIBRARY</span><i></i><i></i><i></i></div><div class="login-book-flip-page login-book-flip-one"></div><div class="login-book-flip-page login-book-flip-two"></div><div class="login-book-flip-page login-book-flip-three"></div><div class="login-book-cover"><div class="login-book-cover-front"><span class="login-book-emblem">${bookLogo}</span><strong>BOOK NEST</strong><small>LIBRARY MANAGEMENT</small></div><div class="login-book-cover-inside"><span></span><span></span><span></span></div></div><div class="login-book-spine"></div></div><p class="login-opening-caption">Opening your library<span aria-hidden="true">...</span></p><div class="login-opening-progress" aria-hidden="true"><span></span></div></div>`;
      return new Promise(resolve=>{
        let timeoutId;
        const finish=()=>{
          window.clearTimeout(timeoutId);
          if(overlay.open)overlay.close();
          overlay.remove();
          document.body.classList.remove("login-opening-active");
          resolve();
        };
        overlay.addEventListener("animationend",event=>{
          if(event.target===overlay&&event.animationName==="login-opening-scene")finish();
        });
        timeoutId=window.setTimeout(finish,4600);
        document.body.append(overlay);
        overlay.showModal();
        document.body.classList.add("login-opening-active");
      });
    }
    function showLogin(message=""){
      clearAccountAvatar();
      currentUser=null;
      root.innerHTML="";
      document.body.classList.remove("application-mode");
      document.body.classList.add("auth-mode");
      authRoot.innerHTML=`<section class="auth-card login-card"><div class="login-header"><span class="brand-mark">${bookLogo}</span><div><span class="login-kicker">BOOK NEST · LIBRARY MANAGEMENT</span><h1>Welcome back</h1></div></div><p>Enter your username and password to continue.</p>${message?`<div class="notice">${esc(message)}</div>`:""}<div class="auth-error" id="auth-error"></div><form id="login-form"><div class="field"><label>Username</label><input name="username" required maxlength="32" autocomplete="username" autofocus></div><div class="field"><label>Password</label><input name="password" type="password" required autocomplete="current-password"></div><button class="button primary">Sign in</button></form><div class="application-actions"><p>New to Book Nest? Submit an application and wait for approval.</p><button class="button light" type="button" data-apply-role="Member">Apply as a Member</button><button class="button light" type="button" data-apply-role="Librarian">Apply as a Librarian</button></div></section>`;
      addPasswordVisibility(authRoot);
      authRoot.querySelector("#login-form").onsubmit=async event=>{
        event.preventDefault();
        const button=event.currentTarget.querySelector("button");button.disabled=true;
        try{await api("/api/auth/login",{method:"POST",body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))});await playLoginOpeningAnimation();await enterApp()}
        catch(error){const box=authRoot.querySelector("#auth-error");box.textContent=error.message;box.classList.add("visible")}
        finally{button.disabled=false}
      };
      authRoot.querySelectorAll("[data-apply-role]").forEach(button=>button.onclick=()=>showApplicationForm(button.dataset.applyRole));
    }
    function showApplicationForm(role){
      const member=role==="Member";
      document.body.classList.add("application-mode");
      const roleDescription=member
        ? "Member applications are reviewed by a librarian or the System Admin."
        : "The System Admin reviews librarian applications. Provide professional details so they can verify your application.";
      const professionalFields=member?"":`<section class="application-section"><div class="application-section-heading"><span class="application-step" aria-hidden="true">02</span><div><h2>Professional details</h2><p>Library and experience details</p></div></div><div class="application-fields"><div class="field"><label>Library or organization</label><input name="institution" required maxlength="180" autocomplete="organization"></div><div class="field"><label>Position applying for</label><input name="position" required maxlength="120" placeholder="e.g. Library Assistant"></div><div class="field"><label>Work email (optional)</label><input name="workEmail" type="email" maxlength="254" autocomplete="email"></div><div class="field"><label>Professional reference (optional)</label><input name="professionalReference" maxlength="180" placeholder="Name and contact details"></div><div class="field application-experience"><label>Relevant library experience</label><textarea name="experience" required maxlength="2000" rows="3" placeholder="Describe your relevant experience and qualifications."></textarea></div><p class="application-privacy">Do not submit passwords, government ID numbers, or sensitive personal documents.</p></div></section>`;
      authRoot.innerHTML=`<section class="auth-card application-card${member?" application-member":""}"><div class="login-header"><span class="brand-mark">${bookLogo}</span><div><span class="login-kicker">BOOK NEST · APPLICATION</span><h1>${member?"Member application":"Librarian application"}</h1></div></div><div class="application-content"><p>${roleDescription}</p><div class="auth-error" id="auth-error"></div><form id="application-form"><section class="application-account"><div class="application-section-heading"><span class="application-step" aria-hidden="true">01</span><div><h2>Account details</h2><p>Personal and login details</p></div></div><div class="application-fields"><div class="field"><label>Full name</label><input name="name" required maxlength="120" autocomplete="name"></div><div class="field"><label>Email</label><input name="email" type="email" required maxlength="254" autocomplete="email"></div><div class="field"><label>Phone (optional, 11 digits max)</label><input name="phone" type="tel" inputmode="numeric" maxlength="11" pattern="[0-9]{0,11}" autocomplete="tel"></div><div class="field"><label>Username</label><input name="username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9._-]+" autocomplete="username"></div><div class="field"><label>Password (10–20 characters)</label><input name="password" type="password" required minlength="10" maxlength="20" autocomplete="new-password"></div><div class="field"><label>Confirm password</label><input name="confirmPassword" type="password" required minlength="10" maxlength="20" autocomplete="new-password"></div></div></section>${professionalFields}<div class="application-form-actions"><button class="button primary">Submit application</button><button class="button light" type="button" id="back-to-login">Back to login</button></div></form></div></section>`;
      addPasswordVisibility(authRoot);
      authRoot.querySelector("#back-to-login").onclick=()=>showLogin();
      authRoot.querySelector("#application-form").onsubmit=async event=>{
        event.preventDefault();
        const values=Object.fromEntries(new FormData(event.currentTarget));
        if(values.password!==values.confirmPassword){
          const error=authRoot.querySelector("#auth-error");error.textContent="The password and confirmation do not match.";error.classList.add("visible");return;
        }
        const button=event.currentTarget.querySelector(".button.primary");
        button.disabled=true;
        try{
          const result=await api("/api/auth/apply",{method:"POST",body:JSON.stringify({...values,role})});
          showLogin(result.message);
        }catch(error){
          const box=authRoot.querySelector("#auth-error");box.textContent=error.message;box.classList.add("visible");
        }finally{button.disabled=false}
      };
    }
    function showSetup(requiresToken=false){
      authRoot.dataset.mode="setup";
      showAuthCard("Create System Admin","First-time setup. The username will be admin. Choose a password with 10 to 20 characters.",`<form id="auth-form">${requiresToken?'<div class="field"><label>Admin setup token</label><input name="setupToken" type="password" required autocomplete="off"></div>':""}<div class="field"><label>Username</label><input value="admin" disabled></div><div class="field"><label>Password</label><input name="password" type="password" minlength="10" maxlength="20" required autocomplete="new-password"></div><div class="field"><label>Confirm password</label><input name="confirmPassword" type="password" minlength="10" maxlength="20" required autocomplete="new-password"></div></form>`,"Create account");
    }
    function applyRole(){
      document.querySelectorAll("[data-roles]").forEach(button=>{
        button.hidden=!button.dataset.roles.split(",").includes(currentUser?.role);
      });
      const member=currentUser.role==="Member";
      const roleLabel=currentUser.role==="SystemAdmin"?"System Admin":currentUser.role;
      document.querySelector("[data-member-history-label]").textContent=member?"History":"Loan history";
      document.querySelector("[data-member-return-label]").textContent=member?"My loans":"Return a book";
      document.querySelector("[data-member-list-label]").textContent="Members";
      const roleClass=currentUser.role==="SystemAdmin"?"system-admin":currentUser.role.toLowerCase();
      const initials=(currentUser.displayName||currentUser.username||"U").trim().split(/\s+/).slice(0,2).map(part=>part[0]).join("").toUpperCase();
      document.getElementById("user-tools").innerHTML=`<button class="button profile-account-button" data-page="profile" aria-label="Open profile"><span class="user-avatar"><span class="user-avatar-fallback">${esc(initials)}</span><img alt="" hidden></span><span>Profile</span></button><span class="role-label role-identity role-identity-${roleClass}">${esc(roleLabel)}</span>${member?"":'<button class="button logout-button" data-logout><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5"/><path d="m14 16 5-4-5-4m5 4H9"/></svg>Log out</button>'}`;
      const avatar=document.querySelector(".profile-account-button .user-avatar");
      const avatarImage=avatar.querySelector("img");
      loadAccountAvatar(currentUser.userId,avatar,avatarImage);
    }
    function clearAccountAvatar(){
      avatarRequestGeneration++;
      avatarRequestController?.abort();
      avatarRequestController=null;
      if(avatarObjectUrl){
        URL.revokeObjectURL(avatarObjectUrl);
        avatarObjectUrl=null;
      }
      const avatar=document.querySelector(".profile-account-button .user-avatar");
      const avatarImage=avatar?.querySelector("img");
      if(avatarImage){
        avatarImage.onload=null;
        avatarImage.onerror=null;
        avatarImage.removeAttribute("src");
        avatarImage.hidden=true;
      }
      avatar?.classList.remove("has-photo");
    }
    async function loadAccountAvatar(userId,avatar,avatarImage){
      clearAccountAvatar();
      const generation=avatarRequestGeneration;
      const controller=new AbortController();
      avatarRequestController=controller;
      try{
        const response=await fetch(`/api/auth/profile-picture?user=${encodeURIComponent(userId)}&v=${Date.now()}`,{
          cache:"no-store",
          credentials:"same-origin",
          signal:controller.signal
        });
        if(generation!==avatarRequestGeneration||currentUser?.userId!==userId)return;
        if(response.status===404)return;
        if(!response.ok)throw new Error("The profile picture could not be loaded. Please try again.");
        const imageBlob=await response.blob();
        if(generation!==avatarRequestGeneration||currentUser?.userId!==userId)return;
        avatarObjectUrl=URL.createObjectURL(imageBlob);
        avatarImage.onload=()=>{
          if(generation!==avatarRequestGeneration||currentUser?.userId!==userId)return;
          avatarImage.hidden=false;
          avatar.classList.add("has-photo");
        };
        avatarImage.onerror=()=>{
          if(generation!==avatarRequestGeneration||currentUser?.userId!==userId)return;
          avatarImage.hidden=true;
          avatar.classList.remove("has-photo");
          showError(new Error("The profile picture could not be displayed."));
        };
        avatarImage.src=avatarObjectUrl;
      }catch(error){
        if(error.name==="AbortError"||generation!==avatarRequestGeneration)return;
        avatarImage.hidden=true;
        avatar.classList.remove("has-photo");
        showError(error);
      }
    }
    function setNotificationBadge(name,count){
      const badge=document.querySelector(`[data-notification-badge="${name}"]`);
      if(!badge)return;
      const pendingCount=Number(count)||0;
      badge.textContent=pendingCount>99?"99+":String(pendingCount);
      badge.hidden=pendingCount===0;
      const label=name==="applications"?"pending applications":name==="returns"?"pending return confirmations":"pending borrow and renewal requests";
      badge.setAttribute("aria-label",`${pendingCount} ${label}`);
    }
    function resetStaffNotificationState(){
      notificationRefreshGeneration++;
      refreshingNotificationBadges=false;
      reportedReturnApiError=false;
      knownPendingApplicationIds=null;
      knownPendingBorrowIds=null;
      knownPendingReturnIds=null;
      for(const name of ["applications","borrow","returns"])setNotificationBadge(name,0);
      if(pendingNotificationDialog?.open)pendingNotificationDialog.close();
      pendingNotificationDialog=null;
    }
    function showPendingNotification(newApplications,newBorrowItems,newReturns=0){
      if(newApplications<=0&&newBorrowItems<=0&&newReturns<=0)return;
      if(pendingNotificationDialog?.open)pendingNotificationDialog.close();
      const notification=document.createElement("dialog");
      notification.className="pending-notification-dialog";
      notification.setAttribute("aria-labelledby","pending-notification-title");
      notification.setAttribute("aria-describedby","pending-notification-message");
      const card=document.createElement("section");
      card.className="pending-notification-card";
      const heading=document.createElement("header");
      heading.className="pending-notification-heading";
      const icon=document.createElement("div");
      icon.className="pending-notification-icon";
      icon.setAttribute("aria-hidden","true");
      icon.textContent="!";
      const titleGroup=document.createElement("div");
      titleGroup.className="pending-notification-title-group";
      const eyebrow=document.createElement("span");
      eyebrow.className="pending-notification-eyebrow";
      eyebrow.textContent="PENDING REQUESTS";
      const title=document.createElement("h2");
      title.id="pending-notification-title";
      title.textContent="Pending requests need your attention";
      titleGroup.append(eyebrow,title);
      heading.append(icon,titleGroup);
      const message=document.createElement("p");
      message.id="pending-notification-message";
      const details=[];
      if(newApplications>0)details.push(`${newApplications} ${newApplications===1?"pending application":"pending applications"}`);
      if(newBorrowItems>0)details.push(`${newBorrowItems} pending borrow or renewal ${newBorrowItems===1?"request":"requests"}`);
      if(newReturns>0)details.push(`${newReturns} pending return ${newReturns===1?"confirmation":"confirmations"}`);
      message.textContent=`${details.join(" and ")}. Please review them when you can.`;
      const content=document.createElement("div");
      content.className="pending-notification-content";
      content.append(message);
      const actions=document.createElement("div");
      actions.className="pending-notification-review-actions";
      if(newApplications>0){
        const link=document.createElement("button");
        link.type="button";link.className="button light";link.dataset.page="applications";link.textContent="Review applications";
        link.onclick=()=>notification.close();
        actions.append(link);
      }
      if(newBorrowItems>0){
        const link=document.createElement("button");
        link.type="button";link.className="button light";link.dataset.page="issue";link.textContent="Review borrow requests";
        link.onclick=()=>notification.close();
        actions.append(link);
      }
      if(newReturns>0){
        const link=document.createElement("button");
        link.type="button";link.className="button light";link.dataset.page="return";link.textContent="Review return confirmations";
        link.onclick=()=>notification.close();
        actions.append(link);
      }
      const dismiss=document.createElement("button");
      dismiss.type="button";dismiss.className="button primary pending-notification-dismiss";dismiss.textContent="Got it";
      dismiss.onclick=()=>notification.close();
      content.append(actions,dismiss);
      card.append(heading,content);
      notification.append(card);
      notification.addEventListener("close",()=>{
        if(pendingNotificationDialog===notification)pendingNotificationDialog=null;
        notification.remove();
      },{once:true});
      document.body.append(notification);
      notification.showModal();
      pendingNotificationDialog=notification;
    }
    async function refreshNotificationBadges(){
      if(!currentUser||currentUser.mustChangePassword||currentUser.role==="Member"||refreshingNotificationBadges)return;
      const notificationUser=currentUser;
      const generation=notificationRefreshGeneration;
      refreshingNotificationBadges=true;
      try{
        const [applicationResponse,requestResponse,renewalResponse]=await Promise.all([
          api("/api/applications"),
          api("/api/loans/requests"),
          api("/api/loans/renewals")
        ]);
        if(currentUser!==notificationUser||generation!==notificationRefreshGeneration)return;
        if(!Array.isArray(applicationResponse)||!Array.isArray(requestResponse)||!Array.isArray(renewalResponse))
          throw new Error("The server returned an unexpected pending-request response. Restart BookNest and refresh the page.");
        const applications=applicationResponse;
        const requests=requestResponse;
        const renewals=renewalResponse;
        const applicationCount=applications.length;
        const borrowCount=requests.length+renewals.length;
        setNotificationBadge("applications",applicationCount);
        setNotificationBadge("borrow",borrowCount);
        const applicationIds=new Set(applications.map(application=>`application:${application.id}`));
        const borrowIds=new Set([
          ...requests.map(request=>`borrow:${request.id}`),
          ...renewals.map(request=>`renewal:${request.id}`)
        ]);
        const newApplications=knownPendingApplicationIds===null
          ? applicationCount
          : [...applicationIds].filter(id=>!knownPendingApplicationIds.has(id)).length;
        const newBorrowItems=knownPendingBorrowIds===null
          ? borrowCount
          : [...borrowIds].filter(id=>!knownPendingBorrowIds.has(id)).length;
        knownPendingApplicationIds=applicationIds;
        knownPendingBorrowIds=borrowIds;
        let newReturns=0;
        try{
          const returnResponse=await api("/api/loans/returns");
          if(currentUser!==notificationUser||generation!==notificationRefreshGeneration)return;
          if(!Array.isArray(returnResponse))
            throw new Error("The server returned an unexpected return-confirmation response. Restart BookNest and refresh the page.");
          const returnIds=new Set(returnResponse.map(request=>`return:${request.id}`));
          setNotificationBadge("returns",returnIds.size);
          newReturns=knownPendingReturnIds===null
            ? returnIds.size
            : [...returnIds].filter(id=>!knownPendingReturnIds.has(id)).length;
          knownPendingReturnIds=returnIds;
          reportedReturnApiError=false;
        }catch(error){
          if(currentUser!==notificationUser||generation!==notificationRefreshGeneration)return;
          if(!reportedReturnApiError){
            showError(error);
            reportedReturnApiError=true;
          }
        }
        if(currentUser!==notificationUser||generation!==notificationRefreshGeneration)return;
        showPendingNotification(newApplications,newBorrowItems,newReturns);
      }catch(error){
        if(currentUser===notificationUser&&generation===notificationRefreshGeneration)showError(error);
      }finally{
        if(generation===notificationRefreshGeneration)refreshingNotificationBadges=false;
      }
    }
    function updateClock(){
      const clock=document.getElementById("local-clock");
      const now=new Date();
      clock.dateTime=now.toISOString();
      const hour=now.getHours();
      const period=hour>=5&&hour<11?"morning":hour>=11&&hour<16?"day":hour>=16&&hour<19?"dusk":"night";
      const icons={
        morning:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>',
        day:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>',
        dusk:'<path d="M3 17h18M5 17a7 7 0 0 1 14 0M12 3v3m-7.36.64 2.12 2.12m12.48-2.12-2.12 2.12"/>',
        night:'<path d="M20.9 13A8.5 8.5 0 0 1 11 3.1 8.5 8.5 0 1 0 20.9 13Z"/><path d="m17 4 .5 1.5L19 6l-1.5.5L17 8l-.5-1.5L15 6l1.5-.5L17 4Z"/>'
      };
      clock.dataset.period=period;
      clock.setAttribute("aria-label",`${dateFormat.format(now)}, ${timeFormat.format(now)}`);
      clock.innerHTML=`<span class="weather-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${icons[period]}</svg></span><span class="clock-copy"><span class="clock-date">${dateFormat.format(now)}</span><span class="clock-amp" aria-hidden="true">&amp;</span><span class="clock-time">${timeFormat.format(now)}</span></span>`;
    }
    async function enterApp(){
      let signedInUser;
      try{signedInUser=await api("/api/auth/me")}
      catch(error){
        showLogin("We couldn't load your account. Please sign in again.");
        throw error;
      }
      resetStaffNotificationState();
      currentUser=signedInUser;
      applyRole();
      currentPage=currentUser.mustChangePassword?"changePassword":"dashboard";
      history.replaceState(null,"","#"+currentPage);
      if(!currentUser.mustChangePassword)api("/api/presence",{method:"POST"}).catch(showError);
      await render();
      document.body.classList.remove("auth-mode");
      authRoot.innerHTML="";
      refreshNotificationBadges();
    }
    async function start(){
      try{
        const state=await api("/api/auth/status");
        if(state.adminSetupBlocked){
          showAuthCard("Admin setup is locked","The site administrator must configure ADMIN_SETUP_TOKEN before the first System Admin account can be created.","<form id=\"auth-form\"></form><p>Ask the site owner to finish the secure initial setup.</p>","Unavailable");
          authRoot.querySelector('button[form="auth-form"]').disabled=true;
          return;
        }
        if(state.setupRequired){showSetup(state.setupRequiresToken);return}
        try{await enterApp()}catch{showLogin()}
      }catch(error){
        document.body.classList.add("auth-mode");
        authRoot.innerHTML=`<section class="auth-card"><h1>Unable to connect to the server</h1><p>${esc(error.message)}</p></section>`;
      }
    }
    function notify(message,error=false){
      document.querySelector(".notice")?.remove();
      const box=document.createElement("div");box.className="notice"+(error?" error":"");box.textContent=message;
      root.prepend(box);setTimeout(()=>box.remove(),5000);
    }
    function beginButtonAction(button,label){
      if(button.disabled)return false;
      const actionGroup=button.closest(".application-actions-inline");
      const buttons=actionGroup?[...actionGroup.querySelectorAll("button")]:[button];
      if(buttons.some(actionButton=>actionButton.disabled))return false;
      pendingButtonActions.set(button,buttons.map(actionButton=>({
        button:actionButton,
        text:actionButton.textContent,
        disabled:actionButton.disabled
      })));
      for(const actionButton of buttons)actionButton.disabled=true;
      button.textContent=label;
      button.setAttribute("aria-busy","true");
      return true;
    }
    function endButtonAction(button){
      const states=pendingButtonActions.get(button);
      pendingButtonActions.delete(button);
      if(!states)return;
      for(const state of states){
        if(!state.button.isConnected)continue;
        state.button.disabled=state.disabled;
        state.button.textContent=state.text;
      }
      button.removeAttribute("aria-busy");
    }
    function notifyReceipt(message,draft){
      document.querySelector(".notice")?.remove();
      const box=document.createElement("div");box.className="notice";
      const summary=document.createElement("div");summary.textContent=message;box.append(summary);
      const link=document.createElement("a");
      link.className="button light receipt-draft-link";
      link.textContent="Open receipt email draft";
      link.href=`mailto:${encodeURIComponent(draft.to)}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;
      link.setAttribute("aria-label",`Open receipt email draft addressed to ${draft.to}`);
      box.append(link);
      const hint=document.createElement("div");
      hint.className="receipt-draft-hint";
      hint.textContent=`The receipt was not sent automatically. Your mail app will open a draft addressed to ${draft.to}; press Send to email it.`;
      box.append(hint);
      root.prepend(box);setTimeout(()=>box.remove(),30000);
    }
    function confirmAction({title,message,confirmLabel="Remove",cancelLabel="Keep record",kicker="CONFIRM REMOVE"}){
      return new Promise(resolve=>{
        const dialog=document.createElement("dialog");
        dialog.className="confirm-dialog";
        dialog.setAttribute("aria-labelledby","confirm-dialog-title");
        dialog.setAttribute("aria-describedby","confirm-dialog-message");
        dialog.innerHTML=`<section class="confirm-dialog-card"><header class="confirm-dialog-header"><span class="confirm-dialog-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M4 7h16M10 11v6m4-6v6M5.5 7l1 13h11l1-13M9 7V4h6v3"/></svg></span><div><span class="confirm-dialog-kicker">${esc(kicker)}</span><h2 id="confirm-dialog-title">${esc(title)}</h2></div></header><div class="confirm-dialog-content"><p id="confirm-dialog-message">${esc(message)}</p><div class="confirm-dialog-actions"><button class="button light" type="button" data-confirm-cancel>${esc(cancelLabel)}</button><button class="button confirm-destructive" type="button" data-confirm-accept>${esc(confirmLabel)}</button></div></div></section>`;
        const previouslyFocused=document.activeElement;
        let settled=false;
        dialog.addEventListener("close",()=>{
          if(settled)return;
          settled=true;
          const confirmed=dialog.returnValue==="confirm";
          dialog.remove();
          if(previouslyFocused instanceof HTMLElement&&previouslyFocused.isConnected)previouslyFocused.focus();
          resolve(confirmed);
        },{once:true});
        dialog.addEventListener("click",event=>{
          if(event.target===dialog)dialog.close("cancel");
        });
        dialog.querySelector("[data-confirm-cancel]").onclick=()=>dialog.close("cancel");
        dialog.querySelector("[data-confirm-accept]").onclick=()=>dialog.close("confirm");
        document.body.append(dialog);
        dialog.showModal();
        dialog.querySelector("[data-confirm-cancel]").focus();
      });
    }
    function bookRows(books,{manage=false,borrow=false,compact=false,pin=false,recordsStyle=false}={}){
      if(!books.length)return `<div class="empty"><strong>No books found</strong><p>Add a book or adjust your search.</p></div>`;
      const hasActions=manage||borrow||pin;
      const columns=compact
        ? `<th>AUTHOR</th><th class="center-cell">CATEGORY</th><th class="center-cell">AVAILABILITY</th><th class="center-cell">RENTAL FEE</th>`
        : `<th>AUTHOR</th><th class="center-cell">CATEGORY</th><th class="center-cell">SUBCATEGORY</th>${manage?"<th class=\"center-cell\">YEAR</th>":""}<th class=\"center-cell\">STATUS</th><th class=\"center-cell\">COPIES</th><th class=\"center-cell\">RENTAL FEE</th>${hasActions?"<th class=\"center-cell\">ACTION</th>":""}`;
      return `<div class="scroll">
        <table class="inventory-table${compact?" compact-table":""}${recordsStyle?" books-table":""}">
          <thead><tr><th>TITLE</th>${columns}</tr></thead>
          <tbody>${books.map(book=>`<tr>
            <td><div class="book-title-cell">${book.coverUrl?`<button class="book-cover-view-button" type="button" data-view-book-cover="${esc(book.coverUrl)}" data-book-title="${esc(book.title)}" data-book-author="${esc(book.author)}" aria-label="View cover of ${esc(book.title)}"><img class="book-cover-thumbnail" src="${esc(book.coverUrl)}" alt="" loading="lazy"><span>View cover</span></button>`:`<span class="book-cover-placeholder" aria-hidden="true">${bookLogo}</span>`}<span class="book-title-copy"><span class="primary-cell">${esc(book.title)}</span><span class="secondary">ISBN ${esc(book.isbn)} · #${book.id}</span></span></div></td>
            <td>${esc(book.author)}</td>
            <td class="center-cell"><span class="tag">${esc(book.category)}</span></td>
            ${compact
              ? `<td class="center-cell"><span class="status ${book.stockStatus==="Out of Stock"?"stock-out":book.stockStatus==="Low Stock"?"stock-low":""}">${esc(book.stockStatus)}</span></td><td class="center-cell"><span class="book-rental-fee">₱${Number(book.rentalFee).toFixed(2)}</span><span class="secondary">simulated / 14-day loan</span></td>`
              : `<td class="center-cell"><span class="subcategory-cell">${esc(book.subcategory||"—")}</span></td>
                ${manage?`<td class="center-cell">${esc(book.year??"—")}</td>`:""}
                <td class="center-cell"><span class="status ${book.stockStatus==="Out of Stock"?"stock-out":book.stockStatus==="Low Stock"?"stock-low":""}">${esc(book.stockStatus)}</span><span class="secondary">${book.lostCopies} lost · ${book.damagedCopies} damaged</span></td>
                <td class="center-cell"><span class="copy-count">${book.availableCopies}<span> / ${book.totalCopies}</span></span><span class="secondary">available / total</span></td>
                <td class="center-cell"><span class="book-rental-fee">₱${Number(book.rentalFee).toFixed(2)}</span><span class="secondary">simulated / 14-day loan</span></td>
                ${hasActions||pin?`<td class="center-cell action-cell">${manage?`<details class="book-manage-menu"><summary class="button">Manage book</summary><div class="book-manage-panel">
                  <header class="book-manage-header"><span class="book-manage-mark" aria-hidden="true">${bookLogo}</span><div><span class="book-manage-kicker">BOOK MANAGEMENT</span><strong>${esc(book.title)}</strong><span class="book-manage-subtitle">Copy numbers identify each physical book.</span></div><button class="book-manage-close" type="button" aria-label="Close book management menu" data-close-book-menu>×</button></header>
                  <div class="book-manage-sections">
                    <section class="book-manage-group"><span class="book-manage-group-title">Cover image</span><button class="button cover-upload-button" data-book-cover="${book.id}">${book.coverUrl?"Change cover":"Add cover"}</button><input type="file" accept="image/jpeg,image/png,image/webp" data-book-cover-file="${book.id}" hidden>${book.coverUrl?`<button class="button cover-remove-button" data-remove-book-cover="${book.id}">Remove cover</button>`:""}<span class="book-manage-help">Choose a cover, preview it, then save.</span></section>
                    <section class="book-manage-group"><span class="book-manage-group-title">Inventory</span><button class="button stock-add-button" data-book-stock="${book.id}" data-book-title="${esc(book.title)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Add stock</button><button class="button fee-edit-button" data-book-fee="${book.id}" data-book-title="${esc(book.title)}" data-current-fee="${Number(book.rentalFee).toFixed(2)}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M15 8.5c-.7-.7-1.7-1-3-1-1.3 0-2.3-.4-3-1M12 5.5v13"/></svg>Set fee</button></section>
                    <section class="book-manage-group book-manage-condition"><span class="book-manage-group-title">Copy condition</span><span class="book-manage-counts">${book.availableCopies} available · ${book.damagedCopies} damaged · ${book.lostCopies} lost</span><button class="button condition-damaged-button" data-book-condition="${book.id}" data-book-title="${esc(book.title)}" data-condition="Damaged" data-condition-action="mark" ${book.availableCopies===0?"disabled":""}>Mark a copy damaged</button><button class="button condition-lost-button" data-book-condition="${book.id}" data-book-title="${esc(book.title)}" data-condition="Lost" data-condition-action="mark" ${book.availableCopies===0?"disabled":""}>Mark a copy lost</button>${book.damagedCopies>0?`<button class="button condition-restore-button" data-book-condition="${book.id}" data-book-title="${esc(book.title)}" data-condition="Damaged" data-condition-action="restore">Restore a damaged copy</button>`:""}${book.lostCopies>0?`<button class="button condition-restore-button" data-book-condition="${book.id}" data-book-title="${esc(book.title)}" data-condition="Lost" data-condition-action="restore">Restore a lost copy</button>`:""}<span class="book-manage-help">Choose a specific numbered copy. Borrowed and reserved copies cannot be marked.</span></section>
                    <section class="book-manage-group book-manage-danger"><span class="book-manage-group-title">Danger zone</span><button class="button delete-button" data-delete-book="${book.id}">Delete book</button></section>
                  </div>
                </div></details>`:""}${borrow?(book.hasPendingRequest?`<button class="button light" disabled>Pending approval</button>`:book.availableCopies>0?`<button class="button primary" data-borrow-book="${book.id}">Request to borrow</button>`:book.hasActiveLoan?`<button class="button light" disabled>Borrowed</button>`:""):""}${pin?`<button class="button light pin-button" data-pin-book="${book.id}">${book.isPinned?"Unpin":"Pin"}</button>`:""}</td>`:""}`}
          </tr>`).join("")}</tbody>
        </table>
      </div>`;
    }
    function loanRows(loans,{allowReturn=false,allowRenew=false}={}){
      if(!loans.length)return `<div class="empty"><strong>No loan activity</strong><p>Loan activity will appear here.</p></div>`;
      return `<div class="activity">${loans.map(l=>{
        const statusLabel=l.status==="Returned"?"Returned":l.dueStatus||l.status;
        const statusClass=statusLabel.toLowerCase().replace(/\s+/g,"-");
        return `<div class="activity-item"><span class="activity-mark ${l.status==="Returned"?"done":""}">${l.status==="Issued"?"↗":"✓"}</span><div class="activity-content"><strong>${esc(l.book)}</strong><span>${esc(l.member)} · due ${esc(l.dueDate)} · simulated fee ₱${Number(l.rentalFee).toFixed(2)}${l.dueStatus==="Overdue"?` · ${l.overdueDays} days overdue · fine ₱${Number(l.fineAmount).toFixed(2)}`:""}</span></div><span class="activity-status due-status ${statusClass}">${esc(statusLabel)}</span>${allowRenew&&l.canRenew?`<button class="button light" data-dashboard-renew="${l.id}">Renew</button>`:""}${allowRenew&&l.renewalPending?'<span class="activity-status">Renewal pending</span>':""}${allowReturn?(l.returnPending?'<span class="activity-status">Return pending confirmation</span>':l.renewalPending?'<span class="activity-status">Return request after renewal decision</span>':`<button class="button light" data-dashboard-return="${l.id}">Request return</button>`):""}</div>`;
      }).join("")}</div>`;
    }
    function memberLoanRows(loans){
      if(!loans.length)return `<div class="empty"><strong>No active loans</strong><p>Borrow a book from the collection to see it here.</p></div>`;
      return `<div class="scroll member-loans-scroll"><table class="inventory-table books-table member-loans-table">
        <thead><tr><th>BOOK</th><th>DUE DATE</th><th>SIMULATED FEE</th><th>STATUS</th><th class="center-cell">ACTIONS</th></tr></thead>
        <tbody>${loans.map(loan=>`<tr>
          <td><span class="primary-cell">${esc(loan.book)}</span></td>
          <td>${esc(loan.dueDate)}</td>
          <td><span class="book-rental-fee">₱${Number(loan.rentalFee).toFixed(2)}</span></td>
          <td><span class="status due-status ${loan.dueStatus==="Overdue"?"overdue":loan.dueStatus==="Due soon"?"due-soon":""}">${esc(loan.dueStatus||"On time")}</span>${loan.dueStatus==="Overdue"?`<span class="secondary">${loan.overdueDays} day(s) overdue · ₱${Number(loan.fineAmount).toFixed(2)} fine</span>`:""}</td>
          <td class="member-loan-actions">${loan.returnPending?'<span class="member-loan-note return-pending-note"><span class="member-loan-note-label">Return pending</span><span class="member-loan-note-detail">Awaiting staff confirmation</span></span>':loan.renewalPending?'<span class="member-loan-note renewal-pending-note"><span class="member-loan-note-label">Renewal pending</span><span class="member-loan-note-detail">Return request available after decision</span></span>':`${loan.canRenew?`<button class="button member-renew-button" data-dashboard-renew="${loan.id}">Renew</button>`:""}<button class="button primary member-return-button" data-dashboard-return="${loan.id}">Request return</button>`}</td>
        </tr>`).join("")}</tbody>
      </table></div>`;
    }
    function dashboardQuickActions(actions){
      const icons={
        books:'<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 0 4 22.5z"/><path d="M4 5.5v14A2.5 2.5 0 0 1 6.5 17H20M8 7h8"/>',
        members:'<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20v-1.5a6.5 6.5 0 0 1 13 0V20M16 5a3.5 3.5 0 0 1 0 6m2 3a5.5 5.5 0 0 1 3.5 5.1V20"/>',
        staff:'<circle cx="12" cy="8" r="3.5"/><path d="M5 21v-1.5a7 7 0 0 1 14 0V21z"/><path d="M18 3h3v3"/>',
        applications:'<path d="M8 4H6a2 2 0 0 0-2 2v14h16V6a2 2 0 0 0-2-2h-2"/><rect x="8" y="2.5" width="8" height="4" rx="1"/><path d="m8 13 2.5 2.5L16 10"/>',
        circulation:'<path d="M5 3h10l4 4v4"/><path d="M15 3v5h5M5 3v18h6"/><circle cx="17" cy="17" r="4"/><path d="M17 15v2l1.5 1"/>',
        returns:'<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v17H6.5A2.5 2.5 0 0 0 4 22.5z"/><path d="M4 5.5v14A2.5 2.5 0 0 1 6.5 17H11m3.5-1 2 2 4-4"/>',
        history:'<path d="M6 3h12a2 2 0 0 1 2 2v16H4V5a2 2 0 0 1 2-2Z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
        archive:'<path d="M4 7h16v13H4zM3 4h18v3H3z"/><path d="M9 11h6"/>',
        pinned:'<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>'
      };
      return `<section class="dashboard-quick-actions" aria-label="Quick actions"><div class="dashboard-quick-actions-heading"><span class="eyebrow">AT A GLANCE</span><h2>Quick actions</h2><p>Jump straight to a common task.</p></div><div class="dashboard-quick-actions-list">${actions.map(({page,label,icon})=>`<button class="dashboard-quick-action" type="button" data-page="${page}"><span class="dashboard-quick-action-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${icons[icon]}</svg></span><span class="dashboard-quick-action-label">${esc(label)}</span><span class="dashboard-quick-action-arrow" aria-hidden="true">→</span></button>`).join("")}</div></section>`;
    }
    function dashboardCollectionHeading(count){
      return `<div class="dashboard-panel-heading"><div class="dashboard-panel-title"><span class="dashboard-panel-title-icon" aria-hidden="true">${bookLogo}</span><h2>Book collection</h2><span class="dashboard-panel-count">${count} ${count===1?"title":"titles"}</span></div><p>Your latest titles</p></div>`;
    }
    function dashboardActivityHeading(count){
      const icon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12a2 2 0 0 1 2 2v16H4V5a2 2 0 0 1 2-2Z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>';
      return `<div class="dashboard-panel-heading"><div class="dashboard-panel-title"><span class="dashboard-panel-title-icon" aria-hidden="true">${icon}</span><h2>Recent activity</h2><span class="dashboard-panel-count">${count} ${count===1?"record":"records"}</span></div><p>Latest loan records</p></div>`;
    }
    async function dashboard(){
      const d=await api("/api/dashboard");
      if(currentUser.role==="SystemAdmin"){
        const [members,librarians]=await Promise.all([api("/api/members"),api("/api/users")]);
        const staff=librarians.filter(user=>user.role==="Librarian");
        const onlineMembers=members.filter(member=>presenceStatus(member.status)==="online").length;
        const onlineLibrarians=staff.filter(user=>presenceStatus(user.status)==="online").length;
        root.innerHTML=`<section class="heading admin-dashboard-heading"><div><div class="eyebrow">SYSTEM ADMIN</div><h1>Dashboard</h1><p>Overview of your library, members, and librarian accounts.</p></div></section>
        <section class="stats admin-stats">
          <article class="stat"><div class="stat-top"><span class="stat-icon green">♙</span><span class="stat-caption">MEMBERS</span></div><div class="stat-value">${members.length}</div><div class="stat-label">${onlineMembers} online now · ${members.length-onlineMembers} offline or inactive</div></article>
          <article class="stat"><div class="stat-top"><span class="stat-icon">♙</span><span class="stat-caption">LIBRARIANS</span></div><div class="stat-value">${staff.length}</div><div class="stat-label">${onlineLibrarians} online now · ${staff.length-onlineLibrarians} offline or inactive</div></article>
          <article class="stat"><div class="stat-top"><span class="stat-icon amber">◷</span><span class="stat-caption">INACTIVE MEMBERS</span></div><div class="stat-value">${members.filter(member=>member.status==="Inactive").length}</div><div class="stat-label">No activity for over one year</div></article>
        </section>
        ${dashboardQuickActions([{page:"members",label:"Manage members",icon:"members"},{page:"librarians",label:"Manage librarians",icon:"staff"},{page:"archive",label:"Archived accounts",icon:"archive"},{page:"history",label:"Loan history",icon:"history"}])}
        <div class="dashboard admin-dashboard">
          <section class="panel admin-dashboard-panel dashboard-collection-panel dashboard-notebook-panel"><div class="panel-head">${dashboardCollectionHeading(d.books.slice(0,2).length)}<button class="link" data-page="books">Manage →</button></div>${bookRows(d.books.slice(0,2),{compact:true})}</section>
          <section class="panel admin-dashboard-panel dashboard-notebook-panel"><div class="panel-head">${dashboardActivityHeading(d.loans.slice(0,6).length)}<button class="link" data-page="history">Manage →</button></div>${loanRows(d.loans.slice(0,6))}</section>
        </div>
        <footer class="footer">BookNest · Library Management System</footer>`;
        return;
      }
      if(currentUser.role==="Member"){
        const latestBooks=d.books.slice().sort((a,b)=>b.id-a.id).slice(0,2);
        const overdueCount=d.loans.filter(loan=>loan.dueStatus==="Overdue").length;
        const dueSoonCount=d.loans.filter(loan=>loan.dueStatus==="Due soon").length;
        const dueNotice=overdueCount
          ? `<div class="loan-alert overdue-alert" role="alert"><strong>${overdueCount} overdue book${overdueCount===1?"":"s"}</strong><span>Please return as soon as possible. A ₱5.00-per-day fine applies for each overdue day.</span></div>`
          : dueSoonCount
            ? `<div class="loan-alert due-soon-alert" role="status"><strong>${dueSoonCount} book${dueSoonCount===1?"":"s"} due soon</strong><span>Please return by the due date to avoid a late fine.</span></div>`
            : "";
        root.innerHTML=`<section class="heading member-dashboard-heading"><div><div class="eyebrow">MEMBER PORTAL</div><h1>Hello, ${esc(currentUser.displayName)}!</h1><p>Browse the collection and check your active loans.</p></div></section>
        ${dueNotice}<section class="stats member-stats"><article class="stat"><div class="stat-top"><span class="stat-icon">▤</span><span class="stat-caption">COLLECTION</span></div><div class="stat-value">${d.totalBooks}</div><div class="stat-label">Total books</div></article>
        <article class="stat"><div class="stat-top"><span class="stat-icon green">✓</span><span class="stat-caption">AVAILABLE</span></div><div class="stat-value">${d.availableBooks}</div><div class="stat-label">Available copies</div></article>
        <article class="stat"><div class="stat-top"><span class="stat-icon amber">↗</span><span class="stat-caption">CURRENTLY BORROWED</span></div><div class="stat-value">${d.loans.length}</div><div class="stat-label">Active books</div></article>
        <article class="stat"><div class="stat-top"><span class="stat-icon">▤</span><span class="stat-caption">BORROWED / READ</span></div><div class="stat-value">${d.borrowedBooks} / ${d.readBooks}</div><div class="stat-label">Total borrowed / returned</div></article></section>
        ${dashboardQuickActions([{page:"books",label:"Browse books",icon:"books"},{page:"pinned",label:"Pinned books",icon:"pinned"},{page:"history",label:"Loan history",icon:"history"}])}
        <div class="dashboard member-dashboard"><section class="panel member-dashboard-panel dashboard-collection-panel dashboard-notebook-panel"><div class="panel-head">${dashboardCollectionHeading(latestBooks.length)}<button class="button light" data-page="books">Browse books <span aria-hidden="true">→</span></button></div>${bookRows(latestBooks,{compact:true})}</section>
        <section class="panel member-dashboard-panel"><div class="panel-head"><div><h2>My current borrowed books</h2><p>Due soon alerts appear within 3 days · ₱5.00 fine per overdue day</p></div><button class="button light" data-page="history">Loan history <span aria-hidden="true">→</span></button></div>${memberLoanRows(d.loans)}</section></div><footer class="footer">BookNest · Library Management System</footer>`;
        root.querySelectorAll("[data-dashboard-return]").forEach(button=>button.onclick=async()=>{
          if(!await confirmAction({title:"Request to return this book?",message:"Only send this request after you have handed the physical book to the librarian. The book stays borrowed until staff confirms they received it.",confirmLabel:"Send return request",cancelLabel:"Not yet",kicker:"RETURN REQUEST"}))return;
          if(!beginButtonAction(button,"Sending..."))return;
          try{const result=await api(`/api/loans/${button.dataset.dashboardReturn}/return`,{method:"POST"});await dashboard();notify(result.message)}catch(error){showError(error)}finally{endButtonAction(button)}
        });
        root.querySelectorAll("[data-dashboard-renew]").forEach(button=>button.onclick=async()=>{
          try{const result=await api(`/api/loans/${button.dataset.dashboardRenew}/renewals`,{method:"POST"});await dashboard();notify(result.message)}catch(error){showError(error)}
        });
        return;
      }
      root.innerHTML=`<section class="heading dashboard-welcome"><div class="welcome-copy"><div class="eyebrow">OVERVIEW</div><h1>Good day, ${currentUser.role==="SystemAdmin"?"admin":"librarian"} ✦</h1><p>Here’s what’s happening in your library today.</p></div><button class="button primary" data-page="addBook">＋ Add a book</button></section>
      <section class="stats librarian-stats"><article class="stat"><div class="stat-top"><span class="stat-icon">▤</span><span class="stat-caption">COLLECTION</span></div><div class="stat-value">${d.totalBooks}</div><div class="stat-label">Total books</div></article>
      <article class="stat"><div class="stat-top"><span class="stat-icon green">♙</span><span class="stat-caption">COMMUNITY</span></div><div class="stat-value">${d.totalMembers}</div><div class="stat-label">Registered members</div></article>
      <article class="stat"><div class="stat-top"><span class="stat-icon amber">↗</span><span class="stat-caption">CIRCULATION</span></div><div class="stat-value">${d.issuedBooks}</div><div class="stat-label">Books currently issued</div></article></section>
      ${dashboardQuickActions([{page:"applications",label:"Applications",icon:"applications"},{page:"members",label:"Manage members",icon:"members"},{page:"issue",label:"Borrow requests",icon:"circulation"},{page:"return",label:"Return a book",icon:"returns"}])}
      <div class="dashboard librarian-dashboard"><section class="panel dashboard-collection-panel dashboard-notebook-panel"><div class="panel-head">${dashboardCollectionHeading(d.books.slice(0,2).length)}<button class="link" data-page="books">Manage →</button></div>${bookRows(d.books.slice(0,2),{compact:true})}</section>
      <section class="panel dashboard-notebook-panel"><div class="panel-head">${dashboardActivityHeading(d.loans.slice(0,6).length)}<button class="link" data-page="return">Manage →</button></div>${loanRows(d.loans.slice(0,6))}</section></div><footer class="footer">BookNest · Library Management System</footer>`;
    }
    async function books(search="",bookFilter=selectedBookFilter){
      const requestGeneration=++bookRequestGeneration;
      const currentSearchInput=document.querySelector('#search-form input[name="search"]');
      const restoreSearchFocus=currentSearchInput===document.activeElement;
      const searchSelection=restoreSearchFocus?currentSearchInput.selectionStart:null;
      root.querySelectorAll(".book-manage-menu").forEach(menu=>{menu.open=false});
      document.body.classList.remove("book-manage-open");
      selectedBookFilter=bookFilter||"";
      const query=new URLSearchParams();
      if(search.trim())query.set("search",search.trim());
      const [filterType,filterId]=selectedBookFilter.split(":");
      if(filterType==="category")query.set("categoryId",filterId);
      if(filterType==="subcategory")query.set("subcategoryId",filterId);
      const [responseBooks,availableCategories]=await Promise.all([api(`/api/books${query.size?`?${query}`:""}`),api("/api/categories")]);
      if(requestGeneration!==bookRequestGeneration)return;
      categories=availableCategories;
      const selectedCategory=filterType==="category"?categories.find(category=>String(category.id)===filterId):null;
      const selectedSubcategory=filterType==="subcategory"
        ?categories.flatMap(category=>category.subcategories).find(subcategory=>String(subcategory.id)===filterId)
        :null;
      const selectedBookFilterName=selectedCategory?.name||selectedSubcategory?.name;
      const list=selectedCategory
        ?responseBooks.filter(book=>book.category===selectedCategory.name)
        :selectedSubcategory
          ?responseBooks.filter(book=>book.subcategory===selectedSubcategory.name)
          :responseBooks;
      const staff=currentUser.role!=="Member", member=currentUser.role==="Member";
      const totalCopies=list.reduce((total,book)=>total+book.totalCopies,0);
      const availableCopies=list.reduce((total,book)=>total+book.availableCopies,0);
      root.innerHTML=`<section class="heading books-page-heading"><div><div class="eyebrow">COLLECTION</div><h1>Books</h1><p>Browse and manage the library collection.</p></div>${staff?`<button class="button primary" data-page="addBook">＋ Add a book</button>`:""}</section>
      <section class="panel books-panel"><div class="toolbar books-toolbar"><div class="books-toolbar-heading"><div class="books-toolbar-copy"><div class="books-record-title"><span class="books-record-icon" aria-hidden="true">${bookLogo}</span><span class="books-record-label">Book inventory</span><span class="count books-record-count">${list.length} titles</span></div><p>${availableCopies} available copies out of ${totalCopies} total${search?` · searched “${esc(search)}”`:""}${selectedBookFilter?` · ${esc(selectedBookFilterName||"category")}`:""}</p></div><form id="search-form" class="search books-search"><input name="search" value="${esc(search)}" placeholder="Type a title, author, or keyword..." aria-label="Search by book title, author, or keyword"><label class="books-category-filter"><span>Category / genre</span><select name="bookFilter" aria-label="Filter books by category or genre"><option value="">All categories and genres</option><optgroup label="Categories">${categories.map(category=>`<option value="category:${category.id}" ${`category:${category.id}`===selectedBookFilter?"selected":""}>${esc(category.name)}</option>`).join("")}</optgroup><optgroup label="Genres">${categories.flatMap(category=>category.subcategories).map(subcategory=>`<option value="subcategory:${subcategory.id}" ${`subcategory:${subcategory.id}`===selectedBookFilter?"selected":""}>${esc(subcategory.name)}</option>`).join("")}</optgroup></select></label></form></div></div>${bookRows(list,{manage:staff,borrow:member,pin:member,recordsStyle:true})}</section><footer class="footer">BookNest · Library Management System</footer>`;
      root.querySelectorAll(".book-manage-menu").forEach(menu=>menu.addEventListener("toggle",()=>{
        if(menu.open)root.querySelectorAll(".book-manage-menu[open]").forEach(other=>{if(other!==menu)other.open=false});
        document.body.classList.toggle("book-manage-open",Boolean(root.querySelector(".book-manage-menu[open]")));
      }));
      root.querySelectorAll("[data-close-book-menu]").forEach(button=>button.onclick=()=>{button.closest(".book-manage-menu").open=false});
      const booksSearchForm=document.getElementById("search-form");
      booksSearchForm.onsubmit=event=>{event.preventDefault();clearTimeout(bookSearchTimer);books(booksSearchForm.elements.search.value,booksSearchForm.elements.bookFilter.value).catch(showError)};
      booksSearchForm.elements.search.oninput=event=>{
        const value=event.currentTarget.value;
        clearTimeout(bookSearchTimer);
        bookSearchTimer=setTimeout(()=>books(value,selectedBookFilter).catch(showError),250);
      };
      booksSearchForm.elements.bookFilter.onchange=()=>{
        clearTimeout(bookSearchTimer);
        books(booksSearchForm.elements.search.value,booksSearchForm.elements.bookFilter.value).catch(showError);
      };
      if(restoreSearchFocus){
        const input=booksSearchForm.elements.search;
        input.focus();
        if(searchSelection!==null)input.setSelectionRange(searchSelection,searchSelection);
      }
      root.querySelectorAll("[data-borrow-book]").forEach(button=>button.onclick=async()=>{
        try{
          const result=await api("/api/loans/requests",{method:"POST",body:JSON.stringify({bookId:Number(button.dataset.borrowBook)})});
          await books(search);notify(result.message);
        }catch(error){showError(error)}
      });
      root.querySelectorAll("[data-book-cover]").forEach(button=>{
        const fileInput=root.querySelector(`[data-book-cover-file="${button.dataset.bookCover}"]`);
        button.onclick=()=>fileInput.click();
        fileInput.onchange=async()=>{
          const file=fileInput.files[0];
          if(!file)return;
          if(file.size>2*1024*1024){showError(new Error("Book covers must be 2 MB or smaller."));fileInput.value="";return}
          if(!["image/jpeg","image/png","image/webp"].includes(file.type)){showError(new Error("Choose a JPG, PNG, or WebP cover image."));fileInput.value="";return}
          button.closest(".book-manage-menu").open=false;
          showBookCoverUpload(button.dataset.bookCover,button.closest(".book-manage-panel").querySelector(".book-manage-header strong").textContent,file,search);
          fileInput.value="";
        };
      });
      root.querySelectorAll("[data-remove-book-cover]").forEach(button=>button.onclick=async()=>{
        if(!await confirmAction({title:"Remove this book cover?",message:"The book will remain in the collection without a cover image.",confirmLabel:"Remove cover"}))return;
        try{
          await api(`/api/books/${button.dataset.removeBookCover}/cover`,{method:"DELETE"});
          await books(search);
          notify("Book cover removed.");
        }catch(error){showError(error)}
      });
      root.querySelectorAll("[data-pin-book]").forEach(button=>button.onclick=async()=>{
        if(button.textContent.trim()==="Unpin"&&!await confirmAction({
          title:"Remove this book from pinned books?",
          message:"This book will no longer appear in your pinned collection.",
          confirmLabel:"Unpin",
          cancelLabel:"Keep pinned"
        }))return;
        try{const result=await api(`/api/books/${button.dataset.pinBook}/pin`,{method:"POST"});await books(search);notify(result.message)}catch(error){showError(error)}
      });
      root.querySelectorAll("[data-delete-book]").forEach(button=>button.onclick=async()=>{
        if(!await confirmAction({
          title:"Delete this book?",
          message:"Books with loan history cannot be deleted.",
          confirmLabel:"Delete"
        }))return;
        try{const result=await api(`/api/books/${button.dataset.deleteBook}`,{method:"DELETE"});await books(search);notify(result.message)}catch(error){showError(error)}
      });
      root.querySelectorAll("[data-book-condition]").forEach(button=>button.onclick=async()=>{
        const condition=button.dataset.condition, action=button.dataset.conditionAction;
        try{
          const copies=await api(`/api/books/${button.dataset.bookCondition}/copies`);
          const eligible=copies.filter(copy=>action==="mark"
            ?copy.status==="Available"
            :copy.status===condition);
          if(!eligible.length){
            notify(action==="mark"
              ?"There are no available copies to mark."
              :`There are no copies marked ${condition.toLowerCase()} to restore.`);
            return;
          }
          const dialog=document.createElement("dialog");
          dialog.className="book-copy-dialog";
          dialog.setAttribute("aria-labelledby","book-copy-dialog-title");
          dialog.innerHTML=`<form class="confirm-dialog-card book-copy-dialog-card"><header class="confirm-dialog-header"><span class="confirm-dialog-icon book-copy-dialog-icon" aria-hidden="true">${bookLogo}</span><div><span class="confirm-dialog-kicker">COPY CONDITION</span><h2 id="book-copy-dialog-title">${action==="mark"?"Choose a copy to mark":"Choose a copy to restore"}</h2></div></header><div class="confirm-dialog-content"><p class="book-copy-dialog-book"></p><label class="book-copy-select-label" for="book-copy-select">Physical copy</label><select id="book-copy-select" required>${copies.map(copy=>`<option value="${copy.copyNumber}" ${copy===eligible[0]?"selected":""} ${eligible.includes(copy)?"":"disabled"}>Copy #${copy.copyNumber} — ${esc(copy.status)} · ${esc(copy.detail)}</option>`).join("")}</select><p class="book-copy-dialog-help">Use the matching Copy # label on the physical book. Other copies will not be changed.</p><div class="book-copy-dialog-actions"><button class="button light" type="button" data-copy-cancel>Cancel</button><button class="button primary" type="submit">${action==="mark"?"Continue":"Restore copy"}</button></div></div></form>`;
          dialog.querySelector(".book-copy-dialog-book").textContent=button.dataset.bookTitle;
          dialog.querySelector("[data-copy-cancel]").onclick=()=>dialog.close();
          dialog.addEventListener("click",event=>{if(event.target===dialog)dialog.close()});
          dialog.addEventListener("close",()=>dialog.remove(),{once:true});
          dialog.querySelector("form").onsubmit=async event=>{
            event.preventDefault();
            const copyNumber=Number(dialog.querySelector("#book-copy-select").value);
            if(!await confirmAction({
              title:action==="mark"?`Mark Copy #${copyNumber} as ${condition.toLowerCase()}?`:`Restore Copy #${copyNumber}?`,
              message:`${dialog.querySelector("#book-copy-select").selectedOptions[0].textContent}. Only this physical copy will be updated.`,
              confirmLabel:action==="mark"?"Update inventory":"Restore copy",
              cancelLabel:"Keep record",
              kicker:"UPDATE BOOK CONDITION"
            }))return;
            try{
              const result=await api(`/api/books/${button.dataset.bookCondition}/condition`,{
                method:"POST",
                body:JSON.stringify({condition,action,copyNumber})
              });
              dialog.close();
              await books(search);
              notify(result.message);
            }catch(error){showError(error)}
          };
          document.body.append(dialog);
          dialog.showModal();
          dialog.querySelector("#book-copy-select").focus();
        }catch(error){showError(error)}
      });
      root.querySelectorAll("[data-book-stock], [data-book-fee]").forEach(button=>button.onclick=()=>{
        const isStock=button.hasAttribute("data-book-stock");
        const title=button.dataset.bookTitle;
        const bookId=isStock?button.dataset.bookStock:button.dataset.bookFee;
        const dialog=document.createElement("dialog");
        dialog.className="inventory-edit-dialog";
        dialog.setAttribute("aria-labelledby","inventory-edit-title");
        dialog.setAttribute("aria-describedby","inventory-edit-description");
        const editIcon=isStock
          ?'<svg viewBox="0 0 24 24" focusable="false"><path d="M4 8.5 12 4l8 4.5v8L12 21l-8-4.5v-8Z"/><path d="m4.5 8.7 7.5 4.2 7.5-4.2M12 13v8M12 4v4.5"/><path d="M17.5 3v5M15 5.5h5"/></svg>'
          :'<svg viewBox="0 0 24 24" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M15 8.5c-.7-.7-1.7-1-3-1-1.7 0-2.8.8-2.8 2s1.1 1.8 2.8 2 2.8.8 2.8 2-1.1 2-2.8 2c-1.3 0-2.3-.4-3-1M12 5.5v13"/></svg>';
        const submitIcon=isStock
          ?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>'
          :'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 9.5 17 19 7.5"/></svg>';
        dialog.innerHTML=`<form class="inventory-edit-form"><header class="inventory-edit-header"><span class="inventory-edit-icon" aria-hidden="true">${editIcon}</span><div><span class="inventory-edit-kicker">${isStock?"INVENTORY":"SIMULATED PRICING"}</span><h2 id="inventory-edit-title">${isStock?"Add copies to stock":"Set rental fee"}</h2></div></header><div class="inventory-edit-content"><p id="inventory-edit-description">${esc(title)}${isStock?" · existing borrowed, reserved, lost, and damaged copies will not be changed.":" · the fee is for one 14-day loan. This changes future loans only; existing loan prices stay the same."}</p><label for="inventory-edit-value">${isStock?"Number of copies to add":"Rental price for one 14-day loan (PHP)"}</label><input id="inventory-edit-value" name="value" type="number" required min="${isStock?1:0}" max="${isStock?10000:1000000}" step="${isStock?1:"0.01"}" value="${isStock?1:button.dataset.currentFee}"><div class="inventory-edit-actions"><button class="button light" type="button" data-dialog-cancel>Cancel</button><button class="button inventory-edit-submit" type="submit">${submitIcon}${isStock?"Add copies":"Save fee"}</button></div></div></form>`;
        document.body.append(dialog);
        dialog.addEventListener("close",()=>dialog.remove(),{once:true});
        dialog.querySelector("[data-dialog-cancel]").onclick=()=>dialog.close();
        dialog.querySelector("form").onsubmit=async event=>{
          event.preventDefault();
          const value=Number(new FormData(event.currentTarget).get("value"));
          if(!Number.isFinite(value)||value<(isStock?1:0)||value>(isStock?10000:1000000)||(isStock&&!Number.isInteger(value))||(!isStock&&Math.abs(Math.round(value*100)-value*100)>1e-7)){
            showError(new Error(isStock?"Enter a whole number of copies between 1 and 10,000.":"Enter a rental fee from PHP 0.00 to PHP 1,000,000.00 with up to two decimal places."));
            return;
          }
          const submit=event.currentTarget.querySelector('[type="submit"]');
          if(!beginButtonAction(submit,isStock?"Adding...":"Saving..."))return;
          try{
            const endpoint=isStock?`/api/books/${bookId}/stock`:`/api/books/${bookId}/rental-fee`;
            const body=isStock?{quantity:value}:{rentalFee:value};
            const result=await api(endpoint,{method:"POST",body:JSON.stringify(body)});
            dialog.close();
            await books(search);
            notify(result.message);
          }catch(error){showError(error)}finally{endButtonAction(submit)}
        };
        dialog.showModal();
        dialog.querySelector("input").focus();
      });
    }
    async function pinnedBooks(){
      const list=await api("/api/books/pinned");
      root.innerHTML=`<section class="heading"><div><div class="eyebrow">YOUR COLLECTION</div><h1>Pinned Books</h1><p>Books you have saved for later.</p></div></section><section class="panel history-panel"><div class="toolbar history-toolbar"><div class="history-record-heading"><div class="history-record-title"><span class="history-record-icon" aria-hidden="true">${bookLogo}</span><h2>Your pinned books</h2><span class="count history-record-count">${list.length}</span></div><p>Unpin a book at any time.</p></div></div>${bookRows(list,{borrow:true,pin:true})}</section><footer class="footer">BookNest · Library Management System</footer>`;
      root.querySelectorAll("[data-pin-book]").forEach(button=>button.onclick=async()=>{
        if(!await confirmAction({
          title:"Remove this book from pinned books?",
          message:"This book will no longer appear in your pinned collection.",
          confirmLabel:"Unpin",
          cancelLabel:"Keep pinned"
        }))return;
        try{const result=await api(`/api/books/${button.dataset.pinBook}/pin`,{method:"POST"});await pinnedBooks();notify(result.message)}catch(error){showError(error)}
      });
      root.querySelectorAll("[data-borrow-book]").forEach(button=>button.onclick=async()=>{
        try{const result=await api("/api/loans/requests",{method:"POST",body:JSON.stringify({bookId:Number(button.dataset.borrowBook)})});await pinnedBooks();notify(result.message)}catch(error){showError(error)}
      });
    }
    async function members(){
      const list=await api("/api/members");
      root.innerHTML=`<section class="heading"><div><div class="eyebrow">COMMUNITY</div><h1>Members</h1><p>Manage registered readers, activity status, and current checkouts.</p></div><button class="button primary" data-page="addMember">＋ Add a member</button></section>
      <section class="panel"><div class="toolbar members-toolbar"><div class="members-toolbar-title"><div class="members-title-line"><h2>Registered members: <span class="members-total" role="img" aria-label="${list.length} registered members"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5.5 20v-1.5a6.5 6.5 0 0 1 13 0V20z"/></svg><span>${list.length}</span></span></h2></div><p>Member contact information, active loans, and borrowing history.</p></div></div>${list.length?`<div class="scroll"><table class="members-table"><thead><tr><th>MEMBER</th><th>EMAIL</th><th>PHONE</th><th>LAST SEEN</th><th>ISSUED BOOKS</th><th>HISTORY</th><th>ACTIONS</th></tr></thead><tbody>${list.map(m=>`<tr><td><span class="role-name role-name-member"><span class="primary-cell">${esc(m.name)}</span><span class="role-separator">-</span><span class="role-inline">Member</span></span></td><td>${esc(m.email)}</td><td>${esc(m.phone||"—")}</td><td>${m.lastSeen?`<span class="date-time"><span>${esc(dateFormat.format(new Date(m.lastSeen)))}</span><span>${esc(timeFormat.format(new Date(m.lastSeen)))}</span></span>`:"Never"}</td><td><span class="count">${m.issuedBooks}</span></td>      <td><button class="button light" data-member-history="${m.id}">View</button></td><td><button class="button delete-button" data-delete-member="${m.id}">Archive</button></td></tr>`).join("")}</tbody></table></div>`:`<div class="empty"><strong>No registered members</strong><p>Add a member before issuing books.</p></div>`}</section><footer class="footer">BookNest · Library Management System</footer>`;
      root.querySelectorAll("[data-member-history]").forEach(button=>button.onclick=async()=>{selectedHistoryMember=Number(button.dataset.memberHistory);currentPage="history";await render()});
      root.querySelectorAll("[data-delete-member]").forEach(button=>button.onclick=async()=>{
        if(!await confirmAction({
          title:`Archive ${button.closest("tr").querySelector(".primary-cell").textContent.trim()}?`,
          message:"This member will no longer appear in the active list or be able to sign in. Their loan history will be preserved in the System Admin archive. Members with active loans or pending borrow requests must be cleared first.",
          confirmLabel:"Archive member",
          cancelLabel:"Keep member",
          kicker:"ARCHIVE MEMBER"
        }))return;
        try{const result=await api(`/api/members/${button.dataset.deleteMember}`,{method:"DELETE"});await members();notify(result.message)}catch(error){showError(error)}
      });
    }
    async function applications(){
      const list=await api("/api/applications");
      setNotificationBadge("applications",list.length);
      root.innerHTML=`<section class="heading"><div><div class="eyebrow">ACCOUNT APPROVAL</div><h1>Applications</h1><p>${currentUser.role==="SystemAdmin"?"Review member and librarian applications.":"Review member applications. The System Admin reviews librarian applications."}</p></div></section>
      <section class="panel applications-panel"><div class="toolbar applications-toolbar"><div class="applications-heading"><div class="applications-title"><span class="applications-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 4.5h8a2 2 0 0 1 2 2v13H6v-13a2 2 0 0 1 2-2Z"/><path d="M9 3h6v3H9zM9 11h6M9 15h6"/></svg></span><h2>Pending applications</h2><span class="count applications-count">${list.length}</span></div><p>Review the details, then approve or reject each request.</p></div></div>${list.length?`<div class="scroll"><table class="user-table applications-table"><thead><tr><th>APPLICANT</th><th>ACCOUNT TYPE</th><th>USERNAME</th><th>EMAIL</th><th>PHONE</th><th>PROFESSIONAL DETAILS</th><th>SUBMITTED</th><th></th></tr></thead><tbody>${list.map(application=>`<tr><td><span class="primary-cell">${esc(application.name)}</span></td><td><span class="role-label">${esc(application.role)}</span></td><td>${esc(application.username)}</td><td>${esc(application.email)}</td><td>${esc(application.phone||"—")}</td><td>${application.role==="Librarian"?`<strong>${esc(application.institution)}</strong><span class="secondary">Position: ${esc(application.position)}</span>${application.workEmail?`<span class="secondary">Work email: ${esc(application.workEmail)}</span>`:""}<details class="application-details"><summary>Experience and reference</summary><p>${esc(application.experience)}</p>${application.professionalReference?`<p>Reference: ${esc(application.professionalReference)}</p>`:""}</details>`:"Not required for member applications"}</td><td>${esc(dateFormat.format(new Date(application.submittedAt)))}</td><td class="application-actions-inline"><button class="button primary" data-approve-application="${application.id}">Approve</button><button class="button delete-button" data-reject-application="${application.id}">Reject</button></td></tr>`).join("")}</tbody></table></div>`:`<div class="empty"><strong>No pending applications</strong><p>New account applications will appear here for review.</p></div>`}</section><footer class="footer">BookNest · Library Management System</footer>`;
      root.querySelectorAll("[data-approve-application]").forEach(button=>button.onclick=async()=>{
        if(!beginButtonAction(button,"Approving..."))return;
        try{const result=await api(`/api/applications/${button.dataset.approveApplication}/approve`,{method:"POST"});await applications();notify(result.message)}catch(error){showError(error)}finally{endButtonAction(button)}
      });
      root.querySelectorAll("[data-reject-application]").forEach(button=>button.onclick=async()=>{
        if(!await confirmAction({
          title:"Reject this application?",
          message:"The applicant will not be able to sign in unless they submit a new application.",
          confirmLabel:"Reject",
          cancelLabel:"Keep application",
          kicker:"CONFIRM REJECTION"
        }))return;
        try{const result=await api(`/api/applications/${button.dataset.rejectApplication}/reject`,{method:"POST"});await applications();notify(result.message)}catch(error){showError(error)}
      });
    }
    async function librarians(){
      const list=(await api("/api/users")).filter(user=>user.role==="Librarian");
      root.innerHTML=`<section class="heading"><div><div class="eyebrow">ADMINISTRATION</div><h1>List of Librarians</h1><p>Review librarian accounts, presence, and login history.</p></div><button class="button primary" data-page="applications">Review applications</button></section>
      <section class="panel"><div class="toolbar members-toolbar"><div class="members-toolbar-title"><div class="members-title-line"><h2>Registered librarians: <span class="members-total" role="img" aria-label="${list.length} registered librarians"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5.5 20v-1.5a6.5 6.5 0 0 1 13 0V20z"/></svg><span>${list.length}</span></span></h2></div><p>Online, offline, or inactive based on recent activity.</p></div></div>${list.length?`<div class="scroll"><table class="members-table user-table librarians-table"><thead><tr><th>USERNAME</th><th>NAME</th><th>EMAIL</th><th>STATUS</th><th>LAST SEEN</th><th>LOGIN HISTORY</th><th>ACTIONS</th></tr></thead><tbody>${list.map(user=>`<tr><td><span class="primary-cell">${esc(user.username)}</span></td><td><span class="role-name role-name-librarian"><span class="primary-cell">${esc(user.displayName)}</span><span class="role-separator">-</span><span class="role-inline">Librarian</span></span></td><td>${esc(user.email||"—")}</td><td><span class="presence ${presenceStatus(user.status)}">${esc(user.status||"Offline")}</span>${user.mustChangePassword?'<span class="secondary">Must change temporary password</span>':""}</td><td>${user.lastSeen?`<span class="date-time"><span>${esc(dateFormat.format(new Date(user.lastSeen)))}</span><span>${esc(timeFormat.format(new Date(user.lastSeen)))}</span></span>`:"Never"}</td><td><button class="button light" data-user-history="${user.id}">View history</button></td><td><button class="button delete-button" data-delete-user="${user.id}" data-account-name="${esc(user.displayName)}">Remove</button></td></tr>`).join("")}</tbody></table></div>`:`<div class="empty"><strong>No librarian accounts yet</strong><p>Approve librarian applications to create accounts.</p></div>`}</section><footer class="footer">BookNest · Library Management System</footer>`;
      root.querySelectorAll("[data-delete-user]").forEach(button=>button.onclick=async()=>{
        if(!await confirmAction({
          title:`Archive ${button.dataset.accountName}'s librarian account?`,
          message:"The librarian will no longer be able to sign in. Their account details and login history will be preserved in the System Admin archive.",
          confirmLabel:"Archive librarian",
          cancelLabel:"Keep librarian",
          kicker:"ARCHIVE LIBRARIAN"
        }))return;
        try{
          const result=await api(`/api/users/${button.dataset.deleteUser}`,{method:"DELETE"});
          await librarians();notify(result.message);
        }catch(error){showError(error)}
      });
      root.querySelectorAll("[data-user-history]").forEach(button=>button.onclick=async()=>{
        selectedStaffHistoryId=Number(button.dataset.userHistory);currentPage="staffHistory";await render();
      });
    }
    async function accountArchive(){
      const {accounts,activity}=await api("/api/archive");
      const archiveRows=accounts.length?`<div class="scroll archive-table-scroll"><table class="user-table archive-table archive-accounts-table"><thead><tr><th>ACCOUNT</th><th>EMAIL</th><th>ARCHIVED</th><th>ARCHIVED BY</th><th>LOAN RECORDS</th><th>ACTIVE LOANS</th><th>ACTION</th></tr></thead><tbody>${accounts.map(account=>`<tr><td><span class="primary-cell">${esc(account.name)}</span><span class="secondary">${esc(account.type)}</span></td><td>${esc(account.email||"—")}</td><td>${esc(new Date(account.archivedAt).toLocaleString("en-PH"))}</td><td>${esc(account.archivedBy)}</td><td>${account.loanRecords}</td><td>${account.activeLoans}</td><td><button class="button archive-restore-button" data-restore-account="${account.type}:${account.id}" data-account-name="${esc(account.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 2.64-6.36L3 8"/><path d="M3 3v5h5m4-1v5l3 2"/></svg><span>Restore account</span></button></td></tr>`).join("")}</tbody></table></div>`:`<div class="empty"><strong>No archived accounts</strong><p>Archived members and librarians will be listed here. Their history remains preserved.</p></div>`;
      const activityRows=activity.length?`<div class="scroll archive-table-scroll"><table class="user-table archive-table archive-activity-table"><thead><tr><th>DATE</th><th>ACCOUNT</th><th>EVENT</th><th>BY</th></tr></thead><tbody>${activity.map(event=>`<tr><td>${esc(new Date(event.occurredAt).toLocaleString("en-PH"))}</td><td><span class="primary-cell">${esc(event.name)}</span><span class="secondary">${esc(event.type)} · ${esc(event.email||"—")}</span></td><td><span class="status ${event.action==="Archived"?"issued":"history-returned"}">${esc(event.action)}</span></td><td>${esc(event.actor)}</td></tr>`).join("")}</tbody></table></div>`:`<div class="empty"><strong>No archive activity yet</strong><p>Archive and restore actions will be recorded here.</p></div>`;
      root.innerHTML=`<section class="heading"><div><div class="eyebrow">SYSTEM ADMIN</div><h1>Archived accounts</h1><p>Removed members and librarians are kept here with their history. Restore an account to return it to the active list.</p></div></section><div class="account-archive-layout"><section class="panel archive-panel"><div class="toolbar members-toolbar"><div class="members-toolbar-title"><div class="members-title-line"><h2>Archived accounts <span class="count">${accounts.length}</span></h2></div><p>Accounts cannot sign in while archived. Member accounts with active loans or pending borrow requests cannot be archived.</p></div></div>${archiveRows}</section><section class="panel archive-panel"><div class="toolbar members-toolbar"><div class="members-toolbar-title"><div class="members-title-line"><h2>Archive activity <span class="count">${activity.length}</span></h2></div><p>Recent archive and restore events.</p></div></div>${activityRows}</section></div><footer class="footer">BookNest · Library Management System</footer>`;
      root.querySelectorAll("[data-restore-account]").forEach(button=>button.onclick=async()=>{
        const [type,id]=button.dataset.restoreAccount.split(":");
        if(!await confirmAction({
          title:`Restore ${button.dataset.accountName}?`,
          message:"This account will be returned to the active list and will be able to sign in again. Its archived loan and account history will remain intact.",
          confirmLabel:"Restore account",
          cancelLabel:"Keep archived",
          kicker:"RESTORE ACCOUNT"
        }))return;
        try{
          const result=await api(`/api/archive/${type}/${id}/restore`,{method:"POST"});
          await accountArchive();
          notify(result.message);
        }catch(error){showError(error)}
      });
    }
    async function staffHistory(){
      const [users,history]=await Promise.all([api("/api/users"),api(`/api/users/${selectedStaffHistoryId}/history`)]);
      const user=users.find(item=>item.id===selectedStaffHistoryId);
      const displayName=user?.displayName||"Librarian";
      const accountName=user?.username&&user.username.toLocaleLowerCase()!==displayName.toLocaleLowerCase()
        ?user.username
        :"Librarian account";
      const latestLogin=history[0]?.loginAt?new Date(history[0].loginAt):null;
      const latestLoginLabel=latestLogin&&!Number.isNaN(latestLogin.getTime())
        ?`${dateFormat.format(latestLogin)} · ${timeFormat.format(latestLogin)}`
        :"No sign-ins recorded";
      const rows=history.length?`<ol class="staff-login-list">${history.map((item,index)=>{
        const loginAt=new Date(item.loginAt);
        const validDate=!Number.isNaN(loginAt.getTime());
        return `<li class="staff-login-entry${index===0?" latest":""}"><span class="staff-login-icon-cell"><span class="staff-login-marker" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 7v5l3 2"/><circle cx="12" cy="12" r="9"/></svg></span></span><div class="staff-login-details"><span class="staff-login-label">${index===0?"Most recent sign-in":"Successful sign-in"}</span><time class="staff-login-time"${validDate?` datetime="${esc(loginAt.toISOString())}"`:""}>${validDate?`${esc(dateFormat.format(loginAt))}<span>${esc(timeFormat.format(loginAt))}</span>`:"Date unavailable"}</time></div>${index===0?'<span class="staff-login-latest">LATEST</span>':""}</li>`;
      }).join("")}</ol>`:`<div class="empty"><strong>No login history yet</strong><p>Successful librarian sign-ins will appear here.</p></div>`;
      formShell("ADMINISTRATION","Librarian login history",`Recent account activity for ${esc(displayName)}.`, "⚙",`<section class="panel staff-login-panel"><div class="toolbar staff-login-toolbar"><div class="history-record-heading"><div class="history-record-title"><span class="history-record-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 7v5l3 2"/><circle cx="12" cy="12" r="9"/></svg></span><h2>Sign-in activity</h2><span class="history-record-count">${history.length}</span></div><p>Most recent first · up to 100 successful sign-ins</p></div></div><div class="staff-login-summary"><div class="staff-login-summary-item"><span>LIBRARIAN</span><strong>${esc(displayName)}</strong><small>${esc(accountName)}</small></div><div class="staff-login-summary-item"><span>TOTAL SIGN-INS</span><strong>${history.length}</strong><small>Recorded account sessions</small></div><div class="staff-login-summary-item"><span>LAST SIGN-IN</span><strong>${latestLoginLabel}</strong><small>Most recent successful login</small></div></div><div class="staff-login-list-heading"><h3>Recent sign-ins</h3><span>Newest first</span></div>${rows}</section>`);
    }
    function changePassword(){
      formShell("ACCOUNT","Change password","Choose a new password with 10 to 20 characters.", "♙",`<section class="form-panel"><div class="form-intro"><span class="form-icon">🔒</span><div><h2>${currentUser.mustChangePassword?"Change your temporary password":"Update password"}</h2><p>Choose a password that you do not use for other accounts.</p></div></div><form id="password-form" class="form"><div class="grid"><div class="field wide"><label>Current password</label><input name="currentPassword" type="password" required autocomplete="current-password"></div><div class="field wide"><label>New password</label><input name="newPassword" type="password" required minlength="10" maxlength="20" autocomplete="new-password"></div><div class="field wide"><label>Confirm new password</label><input name="confirmPassword" type="password" required minlength="10" maxlength="20" autocomplete="new-password"></div></div><div class="actions"><button class="button primary">Change password →</button></div></form></section>`);
      addPasswordVisibility(root);
      root.querySelector("#password-form").onsubmit=async event=>{
        event.preventDefault();
        const values=Object.fromEntries(new FormData(event.currentTarget));
        if(values.newPassword!==values.confirmPassword){showError(new Error("The new password and confirmation do not match."));return}
        try{
          const result=await api("/api/auth/change-password",{method:"POST",body:JSON.stringify({currentPassword:values.currentPassword,newPassword:values.newPassword})});
          await enterApp();notify(result.message);
        }catch(error){showError(error)}
      };
    }
    function formShell(eyebrow,title,description,icon,content){
      const backPage=currentPage==="history"&&selectedHistoryMember!==null
        ?"members"
        :currentPage==="addBook"
          ?"books"
          :currentPage==="addMember"
            ?"members"
            :currentPage==="staffHistory"
              ?"librarians"
              :"dashboard";
      root.innerHTML=`<section class="heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${description}</p></div><button class="button light" data-page="${backPage}">← Back</button></section>${content}<footer class="footer">BookNest · Library Management System</footer>`;
    }
    async function addBook(){
      categories=await api("/api/categories");
      const content=`<section class="account-settings-layout add-book-layout">
        <section class="panel add-form-banner"><div class="add-form-banner-content"><div class="add-form-banner-title"><span class="add-form-banner-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 3.5h10l4 4v13H5z"/><path d="M15 3.5v4h4M8 12h8M8 16h8"/></svg></span><h2>New book details</h2></div><p>Complete the information below to add this title to the library collection.</p></div></section>
        <section class="profile-section account-settings-section add-book-card">
          <div class="profile-section-heading"><span class="profile-step">01</span><div><h2>Book information</h2><p>Title, author, ISBN, and publication year</p></div></div>
          <form id="book-form" class="account-settings-form add-book-form">
            <div class="account-settings-fields">
              <div class="field wide"><label>Book title</label><input name="title" required maxlength="200" placeholder="e.g. The Great Gatsby"></div>
              <div class="field"><label>ISBN</label><input name="isbn" required maxlength="32" placeholder="e.g. 9780747532699"></div>
              <div class="field"><label>Publication year</label><input name="publicationYear" type="number" required min="1000" max="${new Date().getFullYear()}" value="${new Date().getFullYear()}"></div>
              <div class="field wide"><label>Author</label><input name="author" required maxlength="160" placeholder="Author’s full name"></div>
            </div>
            <div class="profile-section-heading add-book-subheading"><span class="profile-step">02</span><div><h2>Book cover</h2><p>Add an optional cover image to help readers recognize the book</p></div></div>
            <div class="account-settings-fields">
              <div class="field wide"><div class="book-cover-picker"><span class="book-cover-preview"><span class="book-cover-preview-placeholder" aria-hidden="true">${bookLogo}</span><img id="book-cover-preview" alt="Selected book cover preview" hidden></span><div class="book-cover-picker-details"><label for="book-cover-file">Cover image (optional)</label><input id="book-cover-file" name="cover" type="file" accept="image/jpeg,image/png,image/webp"><span class="field-hint">JPG, PNG, or WebP · up to 2 MB. Drag and zoom to position it in a portrait cover frame. You can change covers later from the Books page.</span></div></div></div>
            </div>
            <div class="profile-section-heading add-book-subheading"><span class="profile-step">03</span><div><h2>Inventory and pricing</h2><p>Set the initial stock and simulated loan price</p></div></div>
            <div class="account-settings-fields add-book-fields">
              <div class="field"><label>Initial stock (copies)</label><input name="totalCopies" type="number" required min="1" max="10000" value="1"></div>
              <div class="field"><label>Rental fee for one 14-day loan (PHP)</label><input name="rentalFee" type="number" required min="0" max="1000000" step="0.01" value="15.00"></div>
              <p class="pricing-note wide">This is the simulated rental price shown to members and included in their receipt. No online payment is processed; any in-person payment happens outside the system.</p>
            </div>
            <div class="profile-section-heading add-book-subheading"><span class="profile-step">04</span><div><h2>Classification</h2><p>Choose where this title belongs in the collection</p></div></div>
            <div class="account-settings-fields add-book-fields">
              <div class="field"><label>Category</label><select name="categoryId" id="category-select" required><option value="">Choose a category</option>${categories.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></div>
              <div class="field"><label>Subcategory</label><select name="subcategoryId" id="subcategory-select" required disabled><option value="">Choose a subcategory</option></select></div>
            </div>
            <div class="account-settings-actions add-book-actions"><button class="button light" type="button" data-page="books">Cancel</button><button class="button primary">Save book →</button></div>
          </form>
        </section>
      </section>`;
      formShell("COLLECTION","Add a book","Add a new title to the library inventory.","▤",content);
      const category=root.querySelector("#category-select"), subcategory=root.querySelector("#subcategory-select");
      const coverInput=root.querySelector("#book-cover-file"), coverPreview=root.querySelector("#book-cover-preview");
      let coverPreviewUrl=null,coverImageBlob=null;
      coverInput.onchange=async()=>{
        const selected=coverInput.files[0];
        if(coverPreviewUrl)URL.revokeObjectURL(coverPreviewUrl);
        coverPreviewUrl=null;coverImageBlob=null;
        if(!selected){coverPreview.hidden=true;coverPreview.parentElement.classList.remove("has-image");return}
        if(selected.size>2*1024*1024||!["image/jpeg","image/png","image/webp"].includes(selected.type)){
          showError(new Error(selected.size>2*1024*1024?"Book covers must be 2 MB or smaller.":"Choose a JPG, PNG, or WebP cover image."));
          coverInput.value="";coverPreview.hidden=true;coverPreview.parentElement.classList.remove("has-image");return;
        }
        const cropped=await cropBookCover(selected,"new book");
        if(!cropped){coverInput.value="";coverPreview.hidden=true;coverPreview.parentElement.classList.remove("has-image");return}
        coverImageBlob=cropped;
        coverPreviewUrl=URL.createObjectURL(cropped);
        coverPreview.src=coverPreviewUrl;
        coverPreview.hidden=false;
        coverPreview.parentElement.classList.add("has-image");
      };
      category.onchange=()=>{const selected=categories.find(c=>String(c.id)===category.value);subcategory.innerHTML=`<option value="">Choose a subcategory</option>${(selected?.subcategories||[]).map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join("")}`;subcategory.disabled=!selected};
      root.querySelector("#book-form").onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,submitButton=form.querySelector('button[type="submit"],button:not([type])');if(coverInput.files[0]&&!coverImageBlob){showError(new Error("Finish positioning the selected cover image before saving the book."));return}submitButton.disabled=true;try{const formData=new FormData(form);if(coverImageBlob)formData.set("cover",new File([coverImageBlob],"book-cover.jpg",{type:"image/jpeg"}));await api("/api/books",{method:"POST",body:formData});if(coverPreviewUrl)URL.revokeObjectURL(coverPreviewUrl);currentPage="books";await render();notify("Book added successfully.")}catch(error){showError(error)}finally{submitButton.disabled=false}};
    }
    async function addMember(){
      const content=`<section class="account-settings-layout add-book-layout add-member-layout">
        <section class="panel add-form-banner"><div class="add-form-banner-content"><div class="add-form-banner-title"><span class="add-form-banner-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M17 8h5M19.5 5.5v5"/></svg></span><h2>New member details</h2></div><p>Enter the new reader’s information to register them with the library.</p></div></section>
        <section class="profile-section account-settings-section add-book-card">
          <div class="profile-section-heading"><span class="profile-step">01</span><div><h2>Personal information</h2><p>A name and email address are required.</p></div></div>
          <form id="member-form" class="account-settings-form add-book-form">
            <div class="account-settings-fields">
              <div class="field wide"><label>Full name</label><input name="name" required maxlength="120" autocomplete="name" placeholder="e.g. Alex Morgan"></div>
              <div class="field"><label>Email address</label><input name="email" type="email" required maxlength="254" autocomplete="email" placeholder="name@example.com"></div>
              <div class="field"><label>Phone (optional)</label><input name="phone" type="tel" maxlength="40" autocomplete="tel" placeholder="Phone number"></div>
            </div>
            <div class="account-settings-actions add-book-actions"><button class="button light" type="button" data-page="members">Cancel</button><button class="button primary">Save member →</button></div>
          </form>
        </section>
      </section>`;
      formShell("COMMUNITY","Add a member","Register a new reader with the library.","♙",content);
      root.querySelector("#member-form").onsubmit=async event=>{event.preventDefault();try{await api("/api/members",{method:"POST",body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))});currentPage="members";await render();notify("Member added successfully.")}catch(error){showError(error)}};
    }
    async function borrowRequestsPage(){
      const [requests,renewals]=await Promise.all([api("/api/loans/requests"),api("/api/loans/renewals")]);
      setNotificationBadge("borrow",requests.length+renewals.length);
      const requestPanel=`<section class="panel applications-panel"><div class="toolbar applications-toolbar"><div class="applications-heading"><div class="applications-title"><span class="applications-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 3h10l4 4v4"/><path d="M15 3v5h5M5 3v18h6"/><circle cx="17" cy="17" r="4"/><path d="M17 15v2l1.5 1"/></svg></span><h2>Member borrow requests</h2><span class="count applications-count">${requests.length}</span></div><p>Approve a member request to make it an active loan, or reject it to release the reserved copy. Fees are simulated for one 14-day loan only; no payment is processed.</p></div></div>${requests.length?`<div class="scroll"><table class="user-table applications-table"><thead><tr><th>MEMBER</th><th>BOOK</th><th>SIMULATED FEE · 14 DAYS</th><th>REQUESTED</th><th>ACTIONS</th></tr></thead><tbody>${requests.map(request=>`<tr><td><span class="primary-cell">${esc(request.member)}</span></td><td>${esc(request.book)}</td><td>₱${Number(request.rentalFee).toFixed(2)}</td><td>${esc(dateFormat.format(new Date(request.requestedAt)))} · ${esc(timeFormat.format(new Date(request.requestedAt)))}</td><td class="application-actions-inline"><button class="button primary" data-approve-loan-request="${request.id}">Approve</button><button class="button delete-button" data-reject-loan-request="${request.id}">Reject</button></td></tr>`).join("")}</tbody></table></div>`:`<div class="empty compact-empty"><strong>No pending member requests</strong><p>New requests will appear here for approval.</p></div>`}</section>
      <section class="panel applications-panel renewal-requests-panel"><div class="toolbar applications-toolbar"><div class="applications-heading"><div class="applications-title"><h2>Pending renewal requests</h2><span class="count applications-count">${renewals.length}</span></div><p>Each eligible loan may be extended once by 14 days.</p></div></div>${renewals.length?`<div class="scroll"><table class="user-table applications-table"><thead><tr><th>MEMBER</th><th>BOOK</th><th>CURRENT DUE DATE</th><th>REQUESTED</th><th>ACTIONS</th></tr></thead><tbody>${renewals.map(request=>`<tr><td><span class="primary-cell">${esc(request.member)}</span></td><td>${esc(request.book)}</td><td>${esc(request.dueDate)}</td><td>${esc(dateFormat.format(new Date(request.requestedAt)))}</td><td class="application-actions-inline"><button class="button primary" data-approve-renewal="${request.id}">Approve</button><button class="button delete-button" data-reject-renewal="${request.id}">Reject</button></td></tr>`).join("")}</tbody></table></div>`:`<div class="empty compact-empty"><strong>No pending renewal requests</strong><p>Member renewal requests will appear here.</p></div>`}</section>`;
      formShell("CIRCULATION","Borrow requests","Review borrow requests and renewals. Approved borrow requests start a 14-day loan.", "↗",requestPanel);
      root.querySelectorAll("[data-approve-loan-request]").forEach(button=>button.onclick=async()=>{
        if(!beginButtonAction(button,"Approving..."))return;
        try{
          const result=await api(`/api/loans/requests/${button.dataset.approveLoanRequest}/approve`,{method:"POST"});
          await borrowRequestsPage();
          if(result.emailSent)notify(result.message);
          else if(result.emailDraft)notifyReceipt(result.message,result.emailDraft);
          else notify(result.message,true);
        }catch(error){
          showError(error);
        }finally{endButtonAction(button)}
      });
      root.querySelectorAll("[data-reject-loan-request]").forEach(button=>button.onclick=async()=>{
        if(!await confirmAction({title:"Reject this borrow request?",message:"The reserved copy will become available to other members.",confirmLabel:"Reject",cancelLabel:"Keep request",kicker:"CONFIRM REJECTION"}))return;
        try{const result=await api(`/api/loans/requests/${button.dataset.rejectLoanRequest}/reject`,{method:"POST"});await borrowRequestsPage();notify(result.message)}catch(error){showError(error)}
      });
      root.querySelectorAll("[data-approve-renewal]").forEach(button=>button.onclick=async()=>{
        if(!beginButtonAction(button,"Approving..."))return;
        try{const result=await api(`/api/loans/renewals/${button.dataset.approveRenewal}/approve`,{method:"POST"});await borrowRequestsPage();notify(result.message)}catch(error){showError(error)}finally{endButtonAction(button)}
      });
      root.querySelectorAll("[data-reject-renewal]").forEach(button=>button.onclick=async()=>{
        try{const result=await api(`/api/loans/renewals/${button.dataset.rejectRenewal}/reject`,{method:"POST"});await borrowRequestsPage();notify(result.message)}catch(error){showError(error)}
      });
    }
    async function returnBook(){
      const member=currentUser.role==="Member";
      const loans=member?await api("/api/loans/active"):null;
      const returns=member?null:await api("/api/loans/returns");
      if(!member)setNotificationBadge("returns",returns.length);
      const intro=member
        ?"After you hand the physical book to the librarian, request a return confirmation here. It remains borrowed until staff confirms receipt."
        :"Confirm a return only after checking that the member physically handed the book in. Confirmation records today as the return date and applies any late fine.";
      const rows=member
        ?loans.map(l=>`<tr><td>${esc(l.book)}</td><td>${esc(l.dueDate)}</td><td>₱${Number(l.rentalFee).toFixed(2)}</td><td><span class="status due-status ${l.dueStatus==="Overdue"?"overdue":l.dueStatus==="Due soon"?"due-soon":""}">${esc(l.dueStatus)}</span>${l.dueStatus==="Overdue"?`<span class="secondary">${l.overdueDays} day(s) · ₱${Number(l.fineAmount).toFixed(2)}</span>`:""}</td><td class="return-actions">${l.returnPending?'<span class="secondary">Awaiting staff confirmation</span>':l.renewalPending?'<span class="secondary">Renewal pending — wait for a decision before requesting return</span>':`${l.canRenew?`<button class="button light" data-renew="${l.id}">Renew</button>`:""}<button class="button primary return-loan-button" data-return="${l.id}">Request return</button>`}</td></tr>`).join("")
        :returns.map(request=>`<tr><td>${esc(request.member)}</td><td>${esc(request.book)}</td><td>${request.copyNumber?`Copy #${request.copyNumber}`:"Copy number unavailable"}</td><td>${esc(request.dueDate)}</td><td>₱${Number(request.rentalFee).toFixed(2)}</td><td>${esc(dateFormat.format(new Date(request.requestedAt)))} · ${esc(timeFormat.format(new Date(request.requestedAt)))}</td><td class="return-actions application-actions-inline"><button class="button primary" data-confirm-return="${request.id}" data-return-member="${esc(request.member)}" data-return-book="${esc(request.book)}" data-return-copy="${request.copyNumber||"unavailable"}">Confirm received</button><button class="button damage-return-button" data-confirm-damaged-return="${request.id}" data-return-member="${esc(request.member)}" data-return-book="${esc(request.book)}" data-return-copy="${request.copyNumber||"unavailable"}" ${request.copyNumber?"":"disabled"}>Received damaged</button><button class="button light" data-return-not-received="${request.id}" data-return-member="${esc(request.member)}" data-return-book="${esc(request.book)}">Not received</button></td></tr>`).join("");
      const emptyTitle=member?"No active loans":"No pending return confirmations";
      const emptyMessage=member?"Borrow a book from the Books section to see it here.":"Member return requests will appear here after they submit them.";
      const content=`<section class="form-panel return-form-panel"><div class="return-form-intro"><div class="return-intro-title"><span class="return-title-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v17H6.5A2.5 2.5 0 0 0 4 22.5v-17ZM20 5.5A2.5 2.5 0 0 0 17.5 3H13v17h4.5a2.5 2.5 0 0 1 2.5 2.5v-17Z"/><path d="M20 10h-5m2-2-2 2 2 2"/></svg></span><h2>${member?"My active loans":"Awaiting return confirmation"}</h2></div><p>${intro}${member?" The rental fee shown is simulated only; no payment is processed.":" Rental fees shown are simulated only; no payment is processed."}</p></div>${(member?loans:returns).length?`<div class="scroll"><table class="return-loans-table${member?"":" staff-return-table"}"><thead><tr>${member?"":"<th>MEMBER</th>"}<th>BOOK</th>${member?"":"<th>COPY #</th>"}<th>DUE DATE</th>${member?"<th>SIMULATED FEE</th><th>STATUS / EST. FINE</th>":"<th>SIMULATED FEE</th><th>REQUESTED</th>"}<th>ACTION</th></tr></thead><tbody>${rows}</tbody></table></div>`:`<div class="empty"><strong>${emptyTitle}</strong><p>${emptyMessage}</p></div>`}</section>`;
      formShell("CIRCULATION",member?"My loans":"Return a book",member?"View your loans and request confirmation after handing a book to staff.":"Review member return requests and confirm receipt.","↙",content);
      root.querySelectorAll("[data-return]").forEach(button=>button.onclick=async()=>{
        if(!await confirmAction({title:"Request to return this book?",message:"Only send this request after you have handed the physical book to the librarian. The book stays borrowed until staff confirms they received it.",confirmLabel:"Send return request",cancelLabel:"Not yet",kicker:"RETURN REQUEST"}))return;
        if(!beginButtonAction(button,"Sending..."))return;
        try{const result=await api(`/api/loans/${button.dataset.return}/return`,{method:"POST"});await returnBook();notify(result.message)}catch(error){showError(error)}finally{endButtonAction(button)}
      });
      root.querySelectorAll("[data-renew]").forEach(button=>button.onclick=async()=>{try{const result=await api(`/api/loans/${button.dataset.renew}/renewals`,{method:"POST"});await returnBook();notify(result.message)}catch(error){showError(error)}});
      root.querySelectorAll("[data-confirm-return]").forEach(button=>button.onclick=async()=>{
        if(!await confirmAction({title:"Confirm this book was received?",message:`Confirm that you physically received “${button.dataset.returnBook}” (Copy #${button.dataset.returnCopy}) from ${button.dataset.returnMember}. This records today as the return date and calculates any late fine.`,confirmLabel:"Confirm received",cancelLabel:"Check again",kicker:"CONFIRM BOOK RETURN"}))return;
        if(!beginButtonAction(button,"Confirming..."))return;
        try{const result=await api(`/api/loans/returns/${button.dataset.confirmReturn}/confirm`,{method:"POST"});await returnBook();notify(result.message)}catch(error){showError(error)}finally{endButtonAction(button)}
      });
      root.querySelectorAll("[data-confirm-damaged-return]").forEach(button=>button.onclick=async()=>{
        if(!await confirmAction({title:"Confirm return and mark damaged?",message:`Confirm you received “${button.dataset.returnBook}” (Copy #${button.dataset.returnCopy}) from ${button.dataset.returnMember} and found that specific copy damaged. It will be recorded as returned and excluded from available stock.`,confirmLabel:"Confirm damaged return",cancelLabel:"Check again",kicker:"DAMAGED BOOK RETURN"}))return;
        if(!beginButtonAction(button,"Recording..."))return;
        try{const result=await api(`/api/loans/returns/${button.dataset.confirmDamagedReturn}/confirm-damaged`,{method:"POST"});await returnBook();notify(result.message)}catch(error){showError(error)}finally{endButtonAction(button)}
      });
      root.querySelectorAll("[data-return-not-received]").forEach(button=>button.onclick=async()=>{
        if(!await confirmAction({title:"Book not received?",message:`Clear ${button.dataset.returnMember}’s request for “${button.dataset.returnBook}”? The loan stays active, and the member can send another request after handing in the book.`,confirmLabel:"Clear request",cancelLabel:"Keep pending",kicker:"RETURN NOT RECEIVED"}))return;
        if(!beginButtonAction(button,"Updating..."))return;
        try{const result=await api(`/api/loans/returns/${button.dataset.returnNotReceived}/not-received`,{method:"POST"});await returnBook();notify(result.message)}catch(error){showError(error)}finally{endButtonAction(button)}
      });
    }
    async function loanHistory(search=selectedHistorySearch,date=selectedHistoryDate){
      const requestGeneration=++historyRequestGeneration;
      const member=currentUser.role==="Member";
      selectedHistorySearch=member?"":search||"";
      selectedHistoryDate=member?"":date||"";
      const query=new URLSearchParams();
      if(selectedHistoryMember!==null)query.set("memberId",selectedHistoryMember);
      if(selectedHistorySearch.trim())query.set("search",selectedHistorySearch.trim());
      if(!member&&selectedHistoryDate)query.set("date",selectedHistoryDate);
      const queryString=query.toString();
      const url=`/api/loans/history${queryString?`?${queryString}`:""}`;
      const historyResults=await api(url);
      if(requestGeneration!==historyRequestGeneration)return false;
      const loans=selectedHistoryDate
        ?historyResults.filter(loan=>String(loan.loanDate).slice(0,10)===selectedHistoryDate)
        :historyResults;
      const filteredMember=selectedHistoryMember!==null;
      const members=filteredMember?await api("/api/members"):[];
      if(requestGeneration!==historyRequestGeneration)return false;
      const selected=filteredMember?members.find(m=>m.id===selectedHistoryMember):null;
      const content=loans.length
        ? `<div class="scroll"><table class="history-table"><thead><tr>${member?"":"<th>MEMBER</th>"}<th>BOOK</th><th>DATE BORROWED</th><th>DUE DATE</th><th>DATE RETURNED</th><th>SIMULATED FEE</th><th>STATUS / FINE</th></tr></thead><tbody>${loans.map(loan=>`<tr>${member?"":`<td>${esc(loan.member)}</td>`}<td><span class="primary-cell">${esc(loan.book)}</span></td><td>${esc(loan.loanDate)}</td><td>${esc(loan.dueDate)}</td><td>${loan.returnDate?esc(loan.returnDate):"—"}</td><td>₱${Number(loan.rentalFee).toFixed(2)}</td><td><span class="status ${loan.status==="Issued"?"issued":"history-returned"}">${esc(loan.status)}</span>${loan.fineAmount>0?`<span class="secondary">Fine: ₱${Number(loan.fineAmount).toFixed(2)}</span>`:""}</td></tr>`).join("")}</tbody></table></div>`
        : `<div class="empty"><strong>${selectedHistorySearch.trim()||selectedHistoryDate?"No matching loan history":"No loan history yet"}</strong><p>${selectedHistorySearch.trim()?"Try a different member name, book title, date, or status.":selectedHistoryDate?"Choose another date or clear the date filter.":member?"Books you borrow and return will appear here.":"Borrowed and returned books will appear here."}</p></div>`;
      const today=localDateOffset(0),yesterday=localDateOffset(-1);
      const dateChoice=selectedHistoryDate===today?"today":selectedHistoryDate===yesterday?"yesterday":selectedHistoryDate?"custom":"all";
      const searchForm=member?"":`<div class="history-filters"><label class="history-date-shortcut"><span>Quick date</span><select data-history-date-shortcut aria-label="Quickly choose a history date"><option value="all" ${dateChoice==="all"?"selected":""}>All dates</option><option value="today" ${dateChoice==="today"?"selected":""}>Today</option><option value="yesterday" ${dateChoice==="yesterday"?"selected":""}>Yesterday</option><option value="custom" ${dateChoice==="custom"?"selected":""}>Choose date</option></select></label><label class="history-date-filter"><span>Borrowed on</span><input data-history-date type="date" value="${esc(selectedHistoryDate)}" aria-label="Filter loan history by borrowing date"></label><form id="history-search-form" class="search history-search"><input name="search" value="${esc(selectedHistorySearch)}" placeholder="Search member or book..." aria-label="Search loan history"><button class="button light">Search</button></form><button class="button history-print-button" type="button" data-print-history>Print records</button></div>`;
      const printHeading=member?"":`<header class="history-print-heading"><h1>BookNest · Loan history</h1><p>${filteredMember?`Member: ${esc(selected?.name||"Member")} · `:""}Borrowing date: ${selectedHistoryDate?esc(selectedHistoryDate):"All dates"}</p></header>`;
      formShell(
        "RECORDS",
        member?"My history":filteredMember?`History: ${selected?.name||"Member"}`:"Loan history",
        member?"Only your own borrowing and return records are shown here.":filteredMember?"Borrowing and return records for this member.":"All borrowing and return records in the library.",
        "▤",
        `<section class="panel history-panel">${printHeading}<div class="toolbar history-toolbar"><div class="history-record-heading"><div class="history-record-copy"><div class="history-record-title"><span class="history-record-icon" aria-hidden="true">${bookLogo}</span><h2>${member?"Your records":filteredMember?esc(selected?.name||"Member"):"Library records"}</h2><span class="count history-record-count">${loans.length}</span></div><p>Most recent first</p></div>${searchForm}</div>${filteredMember?'<div class="history-toolbar-action"><button class="button light" data-clear-history>All members</button></div>':""}</div>${content}</section>`
      );
      root.querySelector("#history-search-form")?.addEventListener("submit",event=>{
        event.preventDefault();
        loanHistory(new FormData(event.currentTarget).get("search")?.toString()||"").catch(showError);
      });
      root.querySelector("[data-history-date-shortcut]")?.addEventListener("change",event=>{
        const selection=event.currentTarget.value;
        if(selection==="custom")return;
        const date=selection==="today"?today:selection==="yesterday"?yesterday:"";
        loanHistory(selectedHistorySearch,date).catch(showError);
      });
      root.querySelector("[data-history-date]")?.addEventListener("change",event=>{
        const date=event.currentTarget.value;
        root.querySelector("[data-history-date-shortcut]").value=date===today?"today":date===yesterday?"yesterday":date?"custom":"all";
        loanHistory(selectedHistorySearch,date).catch(showError);
      });
      root.querySelector("[data-print-history]")?.addEventListener("click",async event=>{
        const button=event.currentTarget;
        const date=root.querySelector("[data-history-date]")?.value||"";
        const search=root.querySelector("#history-search-form input[name='search']")?.value||"";
        button.disabled=true;
        try{
          const refreshed=await loanHistory(search,date);
          if(refreshed&&selectedHistoryDate===date)window.print();
        }catch(error){showError(error)}finally{button.disabled=false}
      });
      root.querySelector("[data-clear-history]")?.addEventListener("click",()=>{selectedHistoryMember=null;render()});
      return true;
    }
    async function profile(){
      const account=await api("/api/auth/profile");
      const profileField=(label,value,wide=false)=>String(value??"").trim()
        ? `<div class="profile-detail${wide?" profile-detail-wide":""}"><span>${label}</span><strong>${esc(value)}</strong></div>`
        : "";
      const personalFields=[
        profileField("Full name",account.name),
        profileField("Email address",account.email),
        profileField("Contact number",account.phone),
        profileField("Username",account.username)
      ].filter(Boolean).join("");
      const professionalFields=account.role==="Librarian"?[
        profileField("Library or organization",account.institution),
        profileField("Position applying for",account.position),
        profileField("Work email",account.workEmail),
        profileField("Relevant library experience",account.experience,true),
        profileField("Professional reference",account.professionalReference,true)
      ].filter(Boolean).join(""):"";
      const initials=(account.name||account.username||"U").trim().split(/\s+/).slice(0,2).map(part=>part[0]).join("").toUpperCase();
      const pictureUrl=`/api/auth/profile-picture?user=${currentUser.userId}&v=${currentUser.profilePictureVersion||0}`;
      const pictureEditor=`<div class="profile-picture-editor"><div class="profile-picture-preview"><span class="profile-picture-fallback">${esc(initials)}</span><img id="profile-picture-preview" alt="Your profile picture" hidden></div><div class="profile-picture-copy"><div class="profile-picture-heading"><strong>Profile picture</strong><span class="profile-picture-format">JPG, PNG or WebP · Up to 2 MB</span></div><p>Your photo appears on your account and in the application header.</p><div class="profile-picture-actions"><label class="button primary profile-picture-upload" for="profile-picture-file"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v5h14v-5"/></svg>${account.hasProfilePicture?"Change photo":"Upload photo"}</label><input id="profile-picture-file" type="file" accept="image/jpeg,image/png,image/webp" hidden><button class="button profile-picture-view" type="button" ${account.hasProfilePicture?"":"hidden"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.3-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.3 6.5-9.5 6.5S2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>Preview</button><button class="button profile-picture-remove" type="button" ${account.hasProfilePicture?"":"hidden"}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M5.5 7l1 13h11l1-13M9 7V4h6v3"/></svg>Remove</button></div><div class="profile-picture-crop" hidden><div class="profile-picture-crop-heading"><div><strong>Adjust your photo</strong><span>Drag to position · Zoom to crop</span></div><span class="profile-picture-live">PREVIEW</span></div><canvas id="profile-picture-canvas" width="280" height="280" aria-label="Profile picture crop preview"></canvas><div class="profile-picture-zoom"><label for="profile-picture-zoom">Zoom</label><input id="profile-picture-zoom" type="range" min="1" max="3" step="0.01" value="1"></div><div class="profile-picture-crop-actions"><button class="button light" type="button" data-picture-cancel>Cancel</button><button class="button primary" type="button" data-picture-save>Save photo</button></div></div><span id="profile-picture-status" role="status"></span></div></div>`;
      const section=(number,title,description,fields,className="",afterHeading="")=>fields
        ? `<section class="profile-section ${className}"><div class="profile-section-heading"><span class="profile-step">${number}</span><div><h2>${title}</h2><p>${description}</p></div></div>${afterHeading}<div class="profile-details">${fields}</div></section>`
        : "";
      formShell("ACCOUNT","Profile","View the information saved with your account and manage your password.","♙",`<section class="form-panel profile-panel">${section("01","Personal information","Personal and login details",personalFields,"profile-personal-section",pictureEditor)}<section class="profile-section profile-password-section"><div class="profile-section-heading"><span class="profile-step">02</span><div><h2>Change password</h2><p>Update your account password</p></div></div><form id="profile-password-form" class="profile-password-form"><div class="profile-fields"><div class="field"><label>Current password</label><input name="currentPassword" type="password" required autocomplete="current-password"></div><div class="field"><label>New password</label><input name="newPassword" type="password" required minlength="10" maxlength="20" autocomplete="new-password"></div><div class="field"><label>Confirm new password</label><input name="confirmPassword" type="password" required minlength="10" maxlength="20" autocomplete="new-password"></div><div class="profile-form-actions"><p>Use 10 to 20 characters.</p><button class="button primary">Save new password →</button></div></div></form></section>${section("03","Professional information","Details provided with your librarian application",professionalFields,"profile-professional-section")}<div class="profile-actions">${account.role==="Member"?'<button class="button light" data-page="accountSettings">Edit personal information</button>':""}</div></section><dialog class="profile-picture-dialog" aria-labelledby="profile-picture-dialog-title"><section class="profile-picture-dialog-card"><header class="profile-picture-dialog-heading"><span class="profile-picture-dialog-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/></svg></span><div class="profile-picture-dialog-title-group"><span class="profile-picture-dialog-eyebrow">ACCOUNT PHOTO</span><h2 id="profile-picture-dialog-title">${esc(account.name||account.username)}</h2></div><button class="profile-picture-dialog-close" type="button" aria-label="Close profile photo preview"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header><div class="profile-picture-dialog-content"><img src="${pictureUrl}" alt="${esc((account.name||account.username)+" profile picture")}"></div></section></dialog>`);
      addPasswordVisibility(root);
      const pictureInput=root.querySelector("#profile-picture-file");
      const picturePreview=root.querySelector("#profile-picture-preview");
      const pictureStatus=root.querySelector("#profile-picture-status");
      const removePictureButton=root.querySelector(".profile-picture-remove");
      const viewPictureButton=root.querySelector(".profile-picture-view");
      const pictureDialog=root.querySelector(".profile-picture-dialog");
      const cropEditor=root.querySelector(".profile-picture-crop");
      const cropCanvas=root.querySelector("#profile-picture-canvas");
      const cropContext=cropCanvas.getContext("2d");
      const zoomInput=root.querySelector("#profile-picture-zoom");
      const savePictureButton=root.querySelector("[data-picture-save]");
      const cancelPictureButton=root.querySelector("[data-picture-cancel]");
      let cropImage=null,cropObjectUrl=null,cropScale=1,cropX=0,cropY=0,dragPointer=null;
      const cropSize=cropCanvas.width;
      const clampCrop=()=>{
        const drawnWidth=cropImage.naturalWidth*cropScale;
        const drawnHeight=cropImage.naturalHeight*cropScale;
        cropX=Math.min(0,Math.max(cropSize-drawnWidth,cropX));
        cropY=Math.min(0,Math.max(cropSize-drawnHeight,cropY));
      };
      const drawCrop=()=>{
        if(!cropImage)return;
        cropScale=Math.max(cropSize/cropImage.naturalWidth,cropSize/cropImage.naturalHeight)*Number(zoomInput.value);
        clampCrop();
        cropContext.clearRect(0,0,cropSize,cropSize);
        cropContext.drawImage(cropImage,cropX,cropY,cropImage.naturalWidth*cropScale,cropImage.naturalHeight*cropScale);
      };
      const closeCrop=()=>{
        cropEditor.hidden=true;
        cropImage=null;
        if(cropObjectUrl)URL.revokeObjectURL(cropObjectUrl);
        cropObjectUrl=null;
        pictureInput.value="";
      };
      picturePreview.onload=()=>{picturePreview.hidden=false;picturePreview.parentElement.classList.add("has-photo")};
      picturePreview.onerror=()=>{picturePreview.hidden=true;picturePreview.parentElement.classList.remove("has-photo")};
      picturePreview.src=pictureUrl;
      viewPictureButton.onclick=()=>pictureDialog.showModal();
      pictureDialog.querySelector(".profile-picture-dialog-close").onclick=()=>pictureDialog.close();
      pictureDialog.addEventListener("click",event=>{if(event.target===pictureDialog)pictureDialog.close()});
      pictureInput.onchange=()=>{
        const file=pictureInput.files[0];
        if(!file)return;
        if(!["image/jpeg","image/png","image/webp"].includes(file.type)||file.size>2*1024*1024){
          pictureStatus.textContent=file.size>2*1024*1024?"Choose an image that is 2 MB or smaller.":"Choose a JPG, PNG, or WebP image.";
          pictureInput.value="";
          return;
        }
        pictureStatus.textContent="";
        if(cropObjectUrl)URL.revokeObjectURL(cropObjectUrl);
        cropObjectUrl=URL.createObjectURL(file);
        const selectedImageUrl=cropObjectUrl;
        cropImage=new Image();
        cropImage.onload=()=>{
          if(cropObjectUrl!==selectedImageUrl)return;
          cropX=(cropSize-cropImage.naturalWidth*Math.max(cropSize/cropImage.naturalWidth,cropSize/cropImage.naturalHeight))/2;
          cropY=(cropSize-cropImage.naturalHeight*Math.max(cropSize/cropImage.naturalWidth,cropSize/cropImage.naturalHeight))/2;
          zoomInput.value="1";
          drawCrop();
          cropEditor.hidden=false;
        };
        cropImage.onerror=()=>{
          if(cropObjectUrl!==selectedImageUrl)return;
          pictureStatus.textContent="The selected image could not be opened. Choose another photo.";
          closeCrop();
        };
        cropImage.src=cropObjectUrl;
      };
      zoomInput.oninput=drawCrop;
      cropCanvas.onpointerdown=event=>{
        if(!cropImage)return;
        dragPointer={id:event.pointerId,x:event.clientX,y:event.clientY};
        cropCanvas.setPointerCapture(event.pointerId);
      };
      cropCanvas.onpointermove=event=>{
        if(!dragPointer||dragPointer.id!==event.pointerId)return;
        const bounds=cropCanvas.getBoundingClientRect();
        cropX+=(event.clientX-dragPointer.x)*cropSize/bounds.width;
        cropY+=(event.clientY-dragPointer.y)*cropSize/bounds.height;
        dragPointer.x=event.clientX;
        dragPointer.y=event.clientY;
        clampCrop();
        cropContext.clearRect(0,0,cropSize,cropSize);
        cropContext.drawImage(cropImage,cropX,cropY,cropImage.naturalWidth*cropScale,cropImage.naturalHeight*cropScale);
      };
      cropCanvas.onpointerup=cropCanvas.onpointercancel=()=>{dragPointer=null};
      cancelPictureButton.onclick=()=>{closeCrop();pictureStatus.textContent=""};
      savePictureButton.onclick=async()=>{
        if(!cropImage)return;
        savePictureButton.disabled=true;
        cancelPictureButton.disabled=true;
        pictureInput.disabled=true;
        removePictureButton.disabled=true;
        pictureStatus.textContent="Saving photo…";
        try{
          let blob=await new Promise(resolve=>cropCanvas.toBlob(resolve,"image/jpeg",0.92));
          if(!blob||blob.type!=="image/jpeg")throw new Error("The adjusted photo could not be prepared. Please try another image.");
          for(let quality=0.82;blob.size>2*1024*1024&&quality>=0.5;quality-=0.08)
            blob=await new Promise(resolve=>cropCanvas.toBlob(resolve,"image/jpeg",quality));
          if(blob.size>2*1024*1024)throw new Error("The adjusted photo is too large. Choose another image.");
          await api("/api/auth/profile-picture",{method:"PUT",headers:{"Content-Type":"image/jpeg"},body:blob});
          currentUser.profilePictureVersion=Date.now();
          closeCrop();
          applyRole();
          await profile();
          notify("Profile picture updated.");
        }catch(error){
          pictureStatus.textContent=error.message;
          showError(error);
          savePictureButton.disabled=false;
          cancelPictureButton.disabled=false;
          pictureInput.disabled=false;
          removePictureButton.disabled=false;
        }
      };
      removePictureButton.onclick=async()=>{
        removePictureButton.disabled=true;
        try{
          await api("/api/auth/profile-picture",{method:"DELETE"});
          currentUser.profilePictureVersion=Date.now();
          applyRole();
          await profile();
          notify("Profile picture removed.");
        }catch(error){
          pictureStatus.textContent=error.message;
          showError(error);
          removePictureButton.disabled=false;
        }
      };
      root.querySelector("#profile-password-form").onsubmit=async event=>{
        event.preventDefault();
        const values=Object.fromEntries(new FormData(event.currentTarget));
        if(values.newPassword!==values.confirmPassword){showError(new Error("The new password and confirmation do not match."));return}
        try{
          const result=await api("/api/auth/change-password",{method:"POST",body:JSON.stringify({currentPassword:values.currentPassword,newPassword:values.newPassword})});
          currentUser.mustChangePassword=false;
          await profile();
          notify(result.message);
        }catch(error){showError(error)}
      };
    }
    async function accountSettings(){
      const librarian=currentUser.role==="Librarian";
      const account=await api(librarian?"/api/auth/profile":"/api/member/account");
      formShell("ACCOUNT","Account Settings","Update your name, email, contact details, and password.", "⚙",`<section class="account-settings-layout">
        <section class="profile-section account-settings-section">
          <div class="profile-section-heading"><span class="profile-step">01</span><div><h2>Personal information</h2><p>Username: ${esc(account.username)}</p></div></div>
          <form id="profile-form" class="account-settings-form">
            <div class="account-settings-fields">
              <div class="field wide"><label>Full name</label><input name="name" required maxlength="120" value="${esc(account.name)}"></div>
              <div class="field"><label>Email</label><input name="email" type="email" required maxlength="254" value="${esc(account.email)}"></div>
              <div class="field"><label>Contact number</label><input name="phone" maxlength="40" value="${esc(account.phone)}"></div>
            </div>
            <div class="account-settings-actions"><button class="button primary">Save account details →</button></div>
          </form>
        </section>
        <section class="profile-section account-settings-section">
          <div class="profile-section-heading"><span class="profile-step">02</span><div><h2>Change password</h2><p>10 to 20 characters.</p></div></div>
          <form id="password-form" class="account-settings-form">
            <div class="account-settings-fields">
              <div class="field"><label>Current password</label><input name="currentPassword" type="password" required autocomplete="current-password"></div>
              <div class="field"><label>New password</label><input name="newPassword" type="password" required minlength="10" maxlength="20" autocomplete="new-password"></div>
              <div class="field"><label>Confirm new password</label><input name="confirmPassword" type="password" required minlength="10" maxlength="20" autocomplete="new-password"></div>
            </div>
            <div class="account-settings-actions"><button class="button primary">Change password →</button></div>
          </form>
        </section>
      </section>`);
      addPasswordVisibility(root);
      root.querySelector("#profile-form").onsubmit=async event=>{
        event.preventDefault();
        try{
          const values=Object.fromEntries(new FormData(event.currentTarget));
          const result=await api(librarian?"/api/auth/profile":"/api/member/account",{method:"PUT",body:JSON.stringify(values)});
          currentUser.displayName=values.name;
          applyRole();
          await accountSettings();
          notify(result.message);
        }catch(error){showError(error)}
      };
      root.querySelector("#password-form").onsubmit=async event=>{
        event.preventDefault();
        const values=Object.fromEntries(new FormData(event.currentTarget));
        if(values.newPassword!==values.confirmPassword){showError(new Error("The new password and confirmation do not match."));return}
        try{
          const result=await api("/api/auth/change-password",{method:"POST",body:JSON.stringify({currentPassword:values.currentPassword,newPassword:values.newPassword})});
          currentUser.mustChangePassword=false;
          await accountSettings();
          notify(result.message);
        }catch(error){showError(error)}
      };
    }
    function showError(error){notify(error.message||"An error occurred. Please try again.",true)}
    async function render(){
      if(!currentUser)return;
      if(currentUser.mustChangePassword&&currentPage!=="changePassword")currentPage="changePassword";
      if(currentPage!=="books"){
        clearTimeout(bookSearchTimer);
        bookSearchTimer=null;
        bookRequestGeneration++;
      }
      const rolePages={
        Member:["dashboard","books","pinned","return","history","profile","accountSettings","changePassword"],
        Librarian:["dashboard","books","members","applications","addBook","addMember","issue","return","history","profile","accountSettings","changePassword"],
        SystemAdmin:["dashboard","books","members","applications","librarians","archive","addBook","addMember","issue","return","history","staffHistory","profile","changePassword"]
      };
      if(!(rolePages[currentUser.role]||[]).includes(currentPage))currentPage="dashboard";
      document.querySelectorAll("[data-page]").forEach(button=>button.classList.toggle("active",button.dataset.page===currentPage));
      crumb.textContent=currentPage==="return"&&currentUser.role==="Member"?"My loans":pageNames[currentPage]||"Dashboard";
      try{
        if(currentPage==="dashboard")await dashboard();
        else if(currentPage==="books")await books();
        else if(currentPage==="pinned")await pinnedBooks();
        else if(currentPage==="members")await members();
        else if(currentPage==="librarians")await librarians();
        else if(currentPage==="addBook")await addBook();
        else if(currentPage==="addMember")await addMember();
        else if(currentPage==="applications")await applications();
        else if(currentPage==="issue")await borrowRequestsPage();
        else if(currentPage==="return")await returnBook();
        else if(currentPage==="history")await loanHistory();
        else if(currentPage==="profile")await profile();
        else if(currentPage==="accountSettings")await accountSettings();
        else if(currentPage==="staffHistory")await staffHistory();
        else if(currentPage==="archive")await accountArchive();
        else if(currentPage==="changePassword")changePassword();
      }
      catch(error){root.innerHTML=`<section class="panel empty"><strong>Unable to load this page</strong><p>${esc(error.message)}</p><button class="button primary" onclick="render()">Try again</button></section>`}
    }
    document.addEventListener("click",async event=>{
      const logout=event.target.closest("[data-logout]");
      if(logout){
        clearAccountAvatar();
        try{await api("/api/auth/logout",{method:"POST"})}finally{resetStaffNotificationState();document.body.classList.add("auth-mode");currentUser=null;showLogin()}
        return;
      }
      const button=event.target.closest("[data-page]");if(!button)return;
      if(pendingNotificationDialog?.open)pendingNotificationDialog.close();
      currentPage=button.dataset.page;
      if(currentPage!=="history"||currentUser?.role!=="Member")selectedHistoryMember=null;
      history.replaceState(null,"","#"+currentPage);render()
    });
    const sidebarToggle=document.querySelector(".sidebar-toggle");
    sidebarToggle.addEventListener("click",()=>{
      const isExpanded=document.body.classList.toggle("sidebar-collapsed")===false;
      sidebarToggle.setAttribute("aria-expanded",String(isExpanded));
      sidebarToggle.setAttribute("aria-label",isExpanded?"Hide navigation":"Show navigation");
      sidebarToggle.innerHTML=isExpanded
        ?'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9 5v14M12.5 9l2.5 3-2.5 3"/></svg>'
        :'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9 5v14M15 9l-2.5 3 2.5 3"/></svg>';
    });
    document.querySelector(".brand").addEventListener("click",event=>{event.preventDefault();selectedHistoryMember=null;currentPage="dashboard";history.replaceState(null,"","#dashboard");render()});
    const initial=location.hash.slice(1);if(pageNames[initial])currentPage=initial;
    updateClock();
    setInterval(updateClock,1000);
    setInterval(()=>{if(currentUser&&!currentUser.mustChangePassword)api("/api/presence",{method:"POST"}).catch(showError)},45000);
    setInterval(refreshNotificationBadges,20000);
    document.addEventListener("visibilitychange",()=>{if(!document.hidden)refreshNotificationBadges()});
    start();
