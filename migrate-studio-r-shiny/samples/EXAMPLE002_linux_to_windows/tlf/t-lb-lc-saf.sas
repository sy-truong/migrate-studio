/* Synthetic R-037 quoted-comment fixture */
%include "&targetStudy.\Dev\Programs\TLF\autoexec.sas";
%put NOTE: "Do not treat /* text in quotes */ as a comment";
%mheadfoot;
proc report data=padam.adlb nowd;
run;
