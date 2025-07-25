import express from "express";
import mongoose from "mongoose";
import 'dotenv/config';
import bcrypt from 'bcrypt';
import { nanoid } from "nanoid";
import jwt from 'jsonwebtoken';
import cors from "cors";
import admin from "firebase-admin";
import serviceAccountKey from "./react-js-blog-website-60539-firebase-adminsdk-5baq5-a0adebceba.json" assert {type:"json"};
import { getAuth } from "firebase-admin/auth";
import { S3Client, PutObjectCommand, NotFound } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";


// Schema
import User from "./Schema/User.js";
import Blog from "./Schema/Blog.js";
import Notification from "./Schema/Notification.js"
import Comment from "./Schema/Comment.js"
import { populate } from "dotenv";

const server = express();
const PORT = 3000;

admin.initializeApp({
    credential: admin.credential.cert(serviceAccountKey)
});

const emailRegex = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/; // regex for email
const passwordRegex = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{6,20}$/; // regex for password

server.use(express.json());
server.use(cors({
  origin: [
    'https://blogspace-by-sid.netlify.app', // ✅ your Netlify frontend
    'http://localhost:3000'                 // ✅ for local dev (optional)
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));


mongoose.connect(process.env.DB_LOCATION, {
autoIndex: true
});

//setting up S3 bucket

const s3Client = new S3Client({
    region: 'ap-south-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

const generateUploadUrl = async () => {
    const date = new Date();
    const imageName = `${nanoid()}-${date.getTime()}.jpeg`;
    
    const command = new PutObjectCommand({
        Bucket: 'sid-blogging-website',
        Key: imageName,
        ContentType: 'image/jpeg',
    });
    
    // Generate the signed URL
    return await getSignedUrl(s3Client, command, { expiresIn: 100 });
};


const formatDatatoSend = (user) => {
    const access_token = jwt.sign({ id: user._id }, process.env.SECRET_ACCESS_KEY);
    return {
        access_token,
        profile_img: user?.personal_info?.profile_img,
        username: user?.personal_info?.username,
        fullname: user?.personal_info?.fullname
    };
};

const generateUsername = async (email) => {
    let username = email.split("@")[0];
    const usernameExists = await User.exists({ "personal_info.username": username });
    return usernameExists ? username + nanoid().substring(0, 5) : username;
};

const verifyJWT = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(" ")[1];

    console.log("Token received:", token);
    
    if (!token) {
        console.log("No access token provided.");
        return res.status(401).json({ error: "No access token" });
    }
    
    jwt.verify(token, process.env.SECRET_ACCESS_KEY, (err, user) => {
        if (err) {
            console.error("JWT verification error:", err);
            return res.status(403).json({ error: "Access token is invalid" });
        }
        
        req.user = user.id;
        console.log("Token verified. User ID:", req.user); // Log for debugging
        next();
    });
};

server.get("/", (req, res) => {
    res.status(200).send("Server is alive");
});



//upload image url route
server.get('/get-upload-url',(req,res)=>{
    generateUploadUrl().then(url=> res.status(200).json({uploadUrl: url})).catch(err=>{
        console.log(err.message);
        return res.status(500).json({error: err.message})
    })
})

server.post('/latest-blogs',(req,res)=>{

    let {page} = req.body

    let maxLimit = 5;

    Blog.find({draft:false})
    .populate("author","personal_info.profile_img personal_info.username personal_info.fullname -_id")
    .sort({"publishedAt":-1})
    .select("blog_id title des banner activity tags publishedAt -_id")
    .skip((page-1)*maxLimit)
    .limit(maxLimit)
    .then(blogs=>{
        return res.status(200).json({blogs})
    })
    .catch(err=>{
        return res.status(500).json({error: err.message})
    })
})

server.post("/all-latest-blogs-count",(req,res)=>{

    Blog.countDocuments({draft: false})
    .then(count =>{
        return res.status(200).json({totalDocs:count})
    })
    .catch(err=>{
        console.log(err.message)
        return res.status(500).json({error:err.message})
    })
})

server.get('/trending-blogs',(req,res)=>{

    Blog.find({draft: false})
    .populate("author","personal_info.profile_img personal_info.username personal_info.fullname -_id")
    .sort({"activity.total_read":-1,"activity.total_likes":-1,"publishedAt":-1})
    .select("blog_id title publishedAt -_id")
    .limit(5)
    .then(blogs=>{
        return res.status(200).json({blogs})
    })
    .catch(err=>{
        return res.status(500).json({error: err.message})
    })
})

server.post("/signup", async (req, res) => {
    const { fullname, email, password } = req.body;
    
    // Validate input
    if (fullname.length < 3) return res.status(403).json({ "error": "Fullname must be at least 3 letters long" });
    if (!email.length) return res.status(403).json({ "error": "Enter Email" });
    if (!emailRegex.test(email)) return res.status(403).json({ "error": "Email is invalid" });
    if (!passwordRegex.test(password)) return res.status(403).json({ "error": "Password should be 6 to 20 characters long with a numeric, 1 lower case and 1 upper case letter" });
    
    try {
        const hashed_password = await bcrypt.hash(password, 10);
        const username = await generateUsername(email);
        const user = new User({
            personal_info: { fullname, email, password: hashed_password, username }
        });
        
        const savedUser = await user.save();
        return res.status(200).json(formatDatatoSend(savedUser));
    } catch (err) {
        if (err.code === 11000) {
            return res.status(500).json({ "error": "Email already exists" });
        }
        return res.status(500).json({ "error": err.message });
    }
});

server.post("/signin", async (req, res) => {
    const { email, password } = req.body;
    
    try {
        const user = await User.findOne({ "personal_info.email": email });
        if (!user) return res.status(403).json({ "error": "Email not found" });
        
        if(!user.google_auth){
            const isPasswordMatch = await bcrypt.compare(password, user.personal_info.password);
            if (!isPasswordMatch) return res.status(403).json({ "error": "Incorrect Password" });
            
            return res.status(200).json(formatDatatoSend(user));
        }
        else{
            return res.status(403).json({"error":"Account was created using google. Try logging in with google."})
        }
        
    } catch (err) {
        console.log(err.message);
        return res.status(500).json({ "error": err.message });
    }
});

server.post("/google-auth", async (req, res) => {
    const { access_token } = req.body;
    
    try {
        const decodedUser = await getAuth().verifyIdToken(access_token);
        const { email, name, picture } = decodedUser;
        
        const profileImage = picture.replace("s96-c", "s384-c");
        
        let user = await User.findOne({ "personal_info.email": email }).select("personal_info.fullname personal_info.username personal_info.profile_img google_auth");
        if (user) { // Login
            if (!user.google_auth) {
                return res.status(403).json({ "error": "This email was signed up without google. Please log in with password to access the account" });
            }
        } else { // Signup
            const username = await generateUsername(email);
            user = new User({
                personal_info: { fullname: name, email, username },
                google_auth: true
            });
            await user.save();
        }
        
        return res.status(200).json(formatDatatoSend(user));
    } catch (err) {
        console.error(err);
        return res.status(500).json({ "error": "Failed to authenticate with Google. Try with another Google account." });
    }
});

server.post("/change-password",verifyJWT,(req,res)=>{

    let {currentPassword,newPassword} = req.body;

    if(!passwordRegex.test(currentPassword) || !passwordRegex.test(newPassword)){
        return res.status(403).json({error:"Password should be 6 to 20 characters long with a numeric, 1 lower case and 1 upper case letter"})
    }

    User.findOneAndUpdate({_id:req.user})
    .then((user)=>{

        if(user.google_auth){
            return res.status(403).json({error:"You can't change password as you logged in through google"})
        }

        bcrypt.compare(currentPassword,user.personal_info.password,(err,result)=>{
            if(err){
                return res.status(500).json({error: "Some error occurred while changing the password, please try again later."})
            }

            if(!result){
                return res.status(403).json({error:"Current password is incorrect, please try again."})
            }

            bcrypt.hash(newPassword,10,(err,hashed_password)=>{

                User.findOneAndUpdate({_id: req.user},{"personal_info.password": hashed_password})
                .then((u)=>{
                    return res.status(200).json({status: "Password changed successfully."})
                })
                .catch(err=>{
                    return res.status(500).json({error: "Some error occurred while changing the password"})
                })
            })
        })
    })
    .catch(err=>{
        console.log(err)
        return res.status(500).json({error: "Some error occurred while changing the password"})
    })


})

server.post("/search-blogs",(req,res)=>{

    let{tag,query,page,author,limit,eliminate_blog} = req.body;

    let findQuery;

    if(tag){
        findQuery = {tags: tag, draft: false,blog_id: {$ne: eliminate_blog}};
    }else if (query){
        findQuery = {draft: false,title: new RegExp(query,'i')}
    }else if(author){
        findQuery = {author,draft:false}
    }

    let maxLimit = limit ? limit : 2;

    Blog.find(findQuery)
    .populate("author","personal_info.profile_img personal_info.username personal_info.fullname -_id")
    .sort({"publishedAt":-1})
    .select("blog_id title des banner activity tags publishedAt -_id")
    .skip((page-1)*maxLimit)
    .limit(maxLimit)
    .then(blogs=>{
        return res.status(200).json({blogs})
    })
    .catch(err=>{
        return res.status(500).json({error: err.message})
    })

})

server.post("/search-blogs-count",(req,res)=>{

    let{tag,author,query} = req.body;

    let findQuery;

    if(tag){
        findQuery = {tags: tag, draft: false};
    }else if (query){
        findQuery = {draft: false,title: new RegExp(query,'i')}
    }else if(author){
        findQuery = {author,draft:false}
    }

    Blog.countDocuments(findQuery)
    .then(count=>{
        return res.status(200).json({totalDocs:count})
    })
    .catch(err=>{
        console.log(err.message)
        return res.status(500).json({error: err.message})
    })

})

server.post("/search-users",(req,res)=>{
    let {query} = req.body;

    User.find({"personal_info.username":new RegExp(query,'i')})
    .limit(50)
    .select("personal_info.fullname personal_info.username personal_info.profile_img -_id")
    .then(users=>{
        return res.status(200).json({users})
    })
    .catch(err=>{
        return res.status(500).json({error: err.message})
    })
})

server.post("/get-profile",(req,res)=>{

    let {username} = req.body;

    User.findOne({"personal_info.username":username})
    .select("-personal_info.password -google_auth -updatedAt -blogs")
    .then(user=>{
        return res.status(200).json(user)
    })
    .catch(err=>{
        console.log(err)
        return res.status(500).json({error: err.message})
    })

})

server.post("/update-profile-img",verifyJWT,(req,res)=>{

    let {url} = req.body;

    User.findOneAndUpdate({_id: req.user},{"personal_info.profile_img":url})
    .then(()=>{
        return res.status(200).json({profile_img:url})
    })
    .catch(err=>{
        return res.status(500).json({error:err.message})
    })

})

server.post("/update-profile",verifyJWT,(req,res)=>{

    let {username,bio,social_links} = req.body;
    let bioLimit = 150;

    if(username.length < 3){
        return res.status(403).json({error: "Username must be at least 3 characters long"})
    }
    if(bio.length > bioLimit){
        return res.status(403).json({error: `Bio should not be more than ${bioLimit} characters`})
    }

    let socialLinksArr = Object.keys(social_links);

    try{

        for(let i = 0; i < socialLinksArr.length; i++){
            if(social_links[socialLinksArr[i]].length){
                let hostname = new URL(social_links[socialLinksArr[i]]).hostname;

                if(!hostname.includes(`${socialLinksArr[i]}.com`) && socialLinksArr[i] != 'website'){
                    return res.status(403).json({error: `Invalid ${socialLinksArr[i]} link`})
                }
            }
        }

    }catch(err){
        return res.status(500).json({error: "You must provide full social links with http(s) included"})
    }

    let updateObj = {
        "personal_info.username":username,
        "personal_info.bio":bio,
        social_links
    }

    User.findOneAndUpdate({_id:req.user},updateObj,{
        runValidators: true
    })
    .then(()=>{
        return res.status(200).json({username})
    })
    .catch(err=>{
        if(err.code == 11000){
            return res.status(409).json({error:"Username is already taken"})
        }
        return res.status(500).json({error:err.message})
    })
})

server.post('/create-blog', verifyJWT, (req, res) => {
    let authorId = req.user;
    let { title, des, banner, tags, content, draft, id } = req.body;

    // Validate title
    if (!title || title.length === 0) {
        return res.status(403).json({ error: "You must provide a title." });
    }

    // If not a draft, validate fields for publishing
    if (!draft) {
        if (!des || des.length === 0 || des.length > 200) {
            return res.status(403).json({ error: "You must provide a description under 200 characters." });
        }
        if (!banner || banner.length === 0) {
            return res.status(403).json({ error: "You must provide a banner to publish the blog." });
        }
        if (!content || !content.blocks || content.blocks.length === 0) {
            return res.status(403).json({ error: "There must be some blog content to publish it." });
        }
        if (!tags || tags.length === 0 || tags.length > 10) {
            return res.status(403).json({ error: "Provide tags to publish the blog, with a maximum of 10." });
        }
    }

    // Normalize tags
    tags = tags.map(tag => tag.toLowerCase());

    // Generate or retrieve blog_id
    let blog_id = id || title.replace(/[^a-zA-Z0-9]/g, ' ').replace(/\s+/g, "-").trim() + nanoid();

    // If editing an existing blog
    if (id) {
        Blog.findOneAndUpdate({ blog_id }, { title, des, banner, content, tags, draft: Boolean(draft) })
            .then(() => {
                return res.status(200).json({ id: blog_id });
            })
            .catch(err => {
                console.error("Error updating blog:", err);
                return res.status(500).json({ error: err.message });
            });
    } else {
        // Creating a new blog
        let blog = new Blog({
            title, des, banner, content, tags, author: authorId, blog_id, draft: Boolean(draft)
        });

        blog.save()
            .then(blog => {
                // Update author's total_posts if it's a published post
                let incrementVal = draft ? 0 : 1;
                User.findOneAndUpdate(
                    { _id: authorId },
                    { $inc: { "account_info.total_posts": incrementVal }, $push: { "blogs": blog._id } }
                )
                    .then(() => {
                        return res.status(200).json({ id: blog.blog_id });
                    })
                    .catch(err => {
                        console.error("Error updating user's total posts:", err);
                        return res.status(500).json({ error: "Failed to update total posts number" });
                    });
            })
            .catch(err => {
                console.error("Error saving blog:", err);
                return res.status(500).json({ error: err.message });
            });
    }
});



server.post("/get-blog",(req,res)=>{

    let {blog_id,draft,mode} = req.body;

    let incrementVal = mode != 'edit' ? 1 : 0;

    Blog.findOneAndUpdate({blog_id},{$inc : {"activity.total_reads": incrementVal}})
    .populate("author","personal_info.fullname personal_info.username personal_info.profile_img")
    .select("title des content banner activity publishedAt blog_id tags")
    .then(blog =>{

        User.findOneAndUpdate({"personal_info.username": blog.author.personal_info.username}, {$inc: {"account_info.total_reads": incrementVal}})
        .catch(err=>{
            return res.status(500).json({error:err.message})
        })

        if(blog.draft && !draft){
            return res.status(500).json({error: 'you cannot access draft blogs'})
        }

        return res.status(200).json({blog});
    })
    .catch(err =>{
        return res.status(500).json({error: err.message})
    })

})

server.post("/like-blog",verifyJWT,(req,res)=>{ //verify jwt act as middleware to verify if the user is logged in or not , we will access this page only if the user is logged in

    let user_id = req.user;
    
    let{_id,isLikeByUser} = req.body

    let incrementVal = !isLikeByUser ? 1 : -1;

    Blog.findOneAndUpdate({_id }, { $inc: {"activity.total_likes": incrementVal}})
    .then(blog=>{

        if(!isLikeByUser){
            let like = new Notification({
                type: "like",
                blog: _id,
                notification_for: blog.author,
                user: user_id
            })

            like.save().then(notification =>{
                return res.status(200).json({liked_by_user: true})
            })
        }else{

            Notification.findOneAndDelete({user: user_id,blog: _id, type: "like"})
            .then(data=>{
                return res.status(200).json({liked_by_user: false})
            })
            .catch(err=>{
                return res.status(500).json({error: err.message})
            })

        }
    })

})

server.post("/isliked-by-user",verifyJWT,(req,res)=>{
    let user_id = req.user;

    let{_id} = req.body;

    Notification.exists({user: user_id,type:"like",blog: _id})
    .then(result=>{
        return res.status(200).json({result})
    })
    .catch(err=>{
        return res.status(500).json({error: err.message})
    })

})

server.post("/add-comment",verifyJWT,(req,res)=>{

    let user_id = req.user;

    let {_id,comment,blog_author,replying_to,notification_id} = req.body

    if(!comment.length){
        return res.status(400).json({error: "Comment cannot be empty"})
    }

    //creating a comment doc
    let commentObj = {
        blog_id: _id, blog_author, comment, commented_by: user_id,
    }

    if(replying_to){
        commentObj.parent = replying_to;
        commentObj.isReply = true
    }

    new Comment(commentObj).save().then(async commentFile =>{

        let {comment, commentedAt, children} = commentFile;

        Blog.findOneAndUpdate({_id}, {$push: {"comments":commentFile._id},$inc: {"activity.total_comments": 1,"activity.total_parent_comments": replying_to ? 0 : 1}})
        .then(blog=>{
            console.log("New Comment created")
        })

        let notificationObj = {
            type: replying_to ? "reply" : "comment",
            blog: _id,
            notification_for: blog_author,
            user: user_id,
            comment: commentFile._id
        }

        if(replying_to){

            notificationObj.replied_on_comment = replying_to;

            await Comment.findOneAndUpdate({_id: replying_to},{$push:{children: commentFile._id}})
            .then(replyingToCommentDoc =>{notificationObj.notification_for = replyingToCommentDoc.commented_by})

            if(notification_id){
                Notification.findOneAndUpdate({_id:notification_id},{reply: commentFile._id})
                .then(notification => console.log('notification updated'))
            }
        }

        new Notification(notificationObj).save().then(notification => console.log("new notification created"))

        return res.status(200).json({
            comment, commentedAt, _id: commentFile._id, user_id, children
        })

    })
})

server.post("/get-blog-comments",(req,res)=>{

    let{blog_id, skip} = req.body;

    let maxLimit = 5;

    Comment.find({blog_id,isReply: false})
    .populate("commented_by","personal_info.username personal_info.fullname personal_info.profile_img")
    .skip(skip)
    .limit(maxLimit)
    .sort({
        'commentedAt': -1
    })
    .then(comment =>{
        return res.status(200).json(comment)
    })
    .catch(err=>{
        console.log(err)
        return res.status(500).json({error:err.message})
    })

})

server.post("/get-replies",(req,res)=>{

    let {_id,skip} = req.body;

    if (!_id || skip === undefined) {
        return res.status(400).json({ error: "Missing parameters" });
    }

    let maxLimit = 5;

    Comment.findOne({_id})
    .populate({
        path: 'children',
        options:{
            limit: maxLimit,
            skip: skip,
            sort: {'commentedAt':-1}
        },
        populate: {
            path: 'commented_by',
            select: "personal_info.profile_img personal_info.username personal_info.fullname"
        },
        select: "-blog_id -updatedAt"
    })
    .select("children")
    .then(doc =>{
        return res.status(200).json({replies: doc.children})
    })
    .catch(err=>{
        return res.status(500).json({error: err.message})
    })
})

const deleteComments = (_id)=>{

    Comment.findOneAndDelete({_id})
    .then(comment =>{

        if(comment.parent){
            Comment.findOneAndUpdate({_id: comment.parent},{$pull:{children: _id}})
            .then(data => console.log("comment delete from parent"))
            .catch(err=> console.log(err))
        }

        Notification.findOneAndDelete({comment: _id}).then(notification => console.log("comment notification deleted"))

        Notification.findOneAndUpdate({reply: _id},{$unset: {reply: 1}}).then(notification => console.log("reply notification deleted"))

        Blog.findOneAndUpdate({_id: comment.blog_id},{$pull: {comments: _id},$inc: {"activity.total_comments":-1 },"activity.total_parent_comments": comment.parent ? 0 : -1})
        .then(blog=>{
            if(comment.children.length){
                comment.children.map(replies=>{
                    deleteComments(replies)
                })
            }
        })
    })
    .catch(err=>{
        console.log(err.message)
    })
}

server.post("/delete-comment",verifyJWT,(req,res)=>{

    let user_id = req.user;

    let{_id} = req.body;

    Comment.findOne({_id})
    .then(comment=>{

        if (!comment) {
            return res.status(404).json({ error: "Comment not found" });
        }

        if(user_id == comment.commented_by || user_id == comment.blog_author){
            
            deleteComments(_id)

            return res.status(200).json({status: "done"})
            
        }
        else{
            return res.status(403).json({error: "You cannot delete the comment"})
        }
    })
})

server.get("/new-notification",verifyJWT,(req,res)=>{
    
    let user_id = req.user;

    Notification.exists({notification_for: user_id,seen: false,user: {$ne: user_id}})
    .then(result=>{
        if(result){
            return res.status(200).json({new_notification_available: true})
        }else{
            return res.status(200).json({new_notification_available: false})
        }
    })
    .catch(err=>{
        console.log(err.message)
        return res.status(500).json({error:err.message})
    })
})

server.post("/notifications",verifyJWT,(req,res)=>{
    let user_id = req.user;

    let {page,filter,deletedDocCount} = req.body;

    let maxLimit = 10;

    let findQuery = {notification_for: user_id,user: {$ne:user_id}}

    let skipDocs = (page-1)*maxLimit;

    if(filter != 'all'){
        findQuery.type = filter;
    }

    if(deletedDocCount){
        skipDocs -= deletedDocCount;
    }

    Notification.find(findQuery)
    .skip(skipDocs)
    .limit(maxLimit)
    .populate("blog","title blog_id")
    .populate("user","personal_info.fullname personal_info.username personal_info.profile_img")
    .populate("comment","comment")
    .populate("replied_on_comment","comment")
    .populate("reply","comment")
    .sort({createdAt: -1})
    .select("createdAt type seen reply")
    .then(notifications=>{

        Notification.updateMany(findQuery,{seen:true})
        .skip(skipDocs)
        .limit(maxLimit)
        .then(()=>console.log('notification seen'))

        return res.status(200).json({notifications})
    })
    .catch(err=>{
        console.log(err.message)
        return res.status(500).json({error: err.message})
    })

})

server.post("/all-notifications-count",verifyJWT,(req,res)=>{
    let user_id = req.user;

    let { filter } = req.body;
    let findQuery = {notification_for: user_id,user: {$ne:user_id}}

    if(filter != 'all'){
        findQuery.type = filter;
    }

    Notification.countDocuments(findQuery)
    .then(count=>{
        return res.status(200).json({totalDocs: count})
    })
    .catch(err=>{
        console.log({error: err.message})
    })

})

server.post("/user-written-blogs",verifyJWT,(req,res)=>{

    let user_id = req.user;

    let {page,draft,query,deletedDocCount} = req.body;

    let maxLimit = 5;
    let skipDocs = (page-1)*maxLimit;

    if(deletedDocCount){
        skipDocs -= deletedDocCount;
    }

    Blog.find({author: user_id,draft,title: new RegExp(query,'i')})
    .skip(skipDocs)
    .limit(maxLimit)
    .sort({publishedAt: -1})
    .select("title banner publishedAt blog_id activity des draft -_id")
    .then(blogs=>{
        return res.status(200).json({blogs})
    })
    .catch(err=>{
        return res.status(500).json({error:err.message})
    })

})

server.post("/user-written-blogs-count",verifyJWT,(req,res)=>{

    let user_id = req.user;
    let {draft,query} = req.body;

    Blog.countDocuments({author: user_id, draft,title: new RegExp(query,'i')})
    .then(count=>{
        return res.status(200).json({totalDocs: count})
    })
    .catch(err=>{
        console.log(err.message)
        return res.status(500).json({error:err.message})
    })
})

server.post("/delete-blog",verifyJWT,(req,res)=>{

    let user_id = req.user;
    let {blog_id} = req.body;

    Blog.findOneAndDelete({blog_id})
    .then(blog=>{

        Notification.deleteMany({blog: blog._id}).then(data=>console.log("Notifications Deleted"))

        Comment.deleteMany({blog_id : blog._id}).then(data=>console.log("Comments Deleted"))

        User.findOneAndUpdate({_id: user_id},{$pull: {blog:blog._id},$inc: {"account_info.total_posts": blog.draft ? 0:-1}})
        .then(user=>console.log("Blog Deleted"))

        return res.status(200).json({status: "done"})

    })
    .catch(err=>{
        return res.status(500).json({error: err.message})
    })
})

server.listen(PORT, () => {
    console.log("Listening on port ->" + PORT);
});
