// Mechanical async propagation for the PostgreSQL adapter integration; reviewed with tsc.
import ts from 'typescript';
import fs from 'node:fs';
const files={
 'server/grey-app.ts':{objects:['store','modelSettings','queue','creations','templates','studioApi','studio','connectorPairing','connectorChannel','auth','xhsSync','localAccounts'],names:['overview','isPlatformAdmin','remoteSync','canDispatch','validateExecutionGrant']},
 'server/studio-routes.ts':{objects:['store','studio','models'],names:['recoverStalledExecutions','launch','canDispatch']},
 'server/studio-execution.ts':{objects:['studio'],names:['get','update','fail']},
 'server/xhs-sync.ts':{objects:['store'],names:['remote']},
 'server/local-accounts.ts':{objects:['store'],names:[]},
 'server/customer-connector.ts':{objects:['channel'],names:['route']},
 'server/connector-channel.ts':{objects:['pairing','storage'],names:['online','binding','selected','select','active','bind','authorize']},
 'server/connector-pairing.ts':{objects:['pairing','auth','channel'],names:['webWorkspace','origin']}
};
const printer=ts.createPrinter({newLine:ts.NewLineKind.LineFeed});
for(const [file,rules] of Object.entries(files)){
 const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const result=ts.transform(source,[ctx=>root=>{
   const f=ctx.factory;
   const functionLike=n=>ts.isArrowFunction(n)||ts.isFunctionExpression(n)||ts.isFunctionDeclaration(n)||ts.isMethodDeclaration(n);
   function ownAwait(n){let yes=false;function walk(c){if(ts.isAwaitExpression(c)){yes=true;return;}if(functionLike(c))return;ts.forEachChild(c,walk);}if(n.body)walk(n.body);return yes;}
   function visit(n){
     let v=ts.visitEachChild(n,visit,ctx);
     if(ts.isCallExpression(v)&&!ts.isAwaitExpression(n.parent)){
       const e=v.expression;const obj=(ts.isPropertyAccessExpression(e)&&ts.isIdentifier(e.expression))?e.expression.text:null;
       const name=ts.isIdentifier(e)?e.text:null;
       if(obj&&rules.objects.includes(obj)||name&&rules.names.includes(name))v=f.createParenthesizedExpression(f.createAwaitExpression(v));
     }
     if(functionLike(v)&&ownAwait(v)&&!v.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword)){
       const mods=[...(v.modifiers??[]),f.createModifier(ts.SyntaxKind.AsyncKeyword)];
       if(ts.isArrowFunction(v))v=f.updateArrowFunction(v,mods,v.typeParameters,v.parameters,v.type,v.equalsGreaterThanToken,v.body);
       if(ts.isFunctionExpression(v))v=f.updateFunctionExpression(v,mods,v.asteriskToken,v.name,v.typeParameters,v.parameters,v.type,v.body);
       if(ts.isFunctionDeclaration(v))v=f.updateFunctionDeclaration(v,mods,v.asteriskToken,v.name,v.typeParameters,v.parameters,v.type,v.body);
       if(ts.isMethodDeclaration(v))v=f.updateMethodDeclaration(v,mods,v.asteriskToken,v.name,v.questionToken,v.typeParameters,v.parameters,v.type,v.body);
     }
     return v;
   }
   return ts.visitNode(root,visit);
 }]);
 fs.writeFileSync(file,printer.printFile(result.transformed[0]));result.dispose();
}
